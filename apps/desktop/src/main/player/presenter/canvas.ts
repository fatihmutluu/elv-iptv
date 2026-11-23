import type { PlayerArea } from '../../../shared/player-ipc.ts';
import type { MpvClient } from '../mpv/client.ts';
import {
  type CanvasEndpoint,
  type IoSurfaceResolver,
  resolveCanvasEndpoint,
  type SharedTexturePlatformHandle,
  withPlatformSurfaceHandle,
} from './iosurface.ts';
import { isAppWindowFullscreen, setAppWindowFullscreen } from './macos-spaces.ts';
import {
  type AppWindowEvent,
  type AppWindowLike,
  createSurfaceTracker,
  type VideoPresenter,
} from './types.ts';

/** Imported GPU shared texture handle returned by Electron's `sharedTexture.importSharedTexture`. */
export interface SharedTextureImportedLike {
  release(): void;
}

/** Injectable subset of Electron's main-process `sharedTexture` API. */
export interface SharedTextureImporterLike<
  TFrame = unknown,
  TImported extends SharedTextureImportedLike = SharedTextureImportedLike,
> {
  importSharedTexture(options: {
    textureInfo: {
      pixelFormat: 'bgra';
      codedSize: { width: number; height: number };
      handle: SharedTexturePlatformHandle;
    };
  }): TImported;
  sendSharedTexture(
    options: { frame: TFrame; importedSharedTexture: TImported },
    ...args: unknown[]
  ): Promise<void>;
}

/** Injectable subset of a Node `net.Socket` accepted by the canvas pipe server. */
export interface CanvasPipeSocketLike {
  write(chunk: string): unknown;
  destroy(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Injectable subset of a Node `net.Server` listening on the canvas IPC endpoint. */
export interface CanvasPipeServerLike {
  listen(options: { path: string; exclusive: boolean }, listeningListener: () => void): unknown;
  on(event: 'connection', listener: (socket: CanvasPipeSocketLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  close(): unknown;
}

/** What `createCanvasPresenter` needs from Electron and Node. */
export interface CanvasPresenterDeps<
  TFrame = unknown,
  TImported extends SharedTextureImportedLike = SharedTextureImportedLike,
> {
  appWindow: AppWindowLike;
  engineId: string;
  sharedTexture: SharedTextureImporterLike<TFrame, TImported>;
  getMainFrame(): TFrame | null | undefined;
  getScaleFactor(): number;
  createPipeServer(pipePath: string): CanvasPipeServerLike;
  onDisplayChange?(listener: () => void): () => void;
  ioSurfaceResolver?: IoSurfaceResolver;
  createEndpoint?(): CanvasEndpoint;
  generatePipeName?(): string;
  useSimpleFullscreen?(): boolean;
  onFullscreenChange?(fullscreen: boolean): void;
}

const MIN_DIM = 16;
const MAX_DIM = 4096;
const MAX_TEXTURE_DIM = 8192;
const MAX_SLOT = 7;
const MAX_BUFFER_BYTES = 16 * 1024;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const UNSIGNED_INT_RE = /^\d+$/;
const FOLLOWED_EVENTS: readonly AppWindowEvent[] = [
  'resize',
  'move',
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
  'minimize',
  'restore',
];

function safeRun(fn: () => void): void {
  try {
    fn();
  } catch {
    // best-effort resource cleanup
  }
}

function positiveOrOne(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
function clampDim(raw: number): number {
  return Number.isFinite(raw) ? Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(raw))) : MIN_DIM;
}
function parseStrictInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || !UNSIGNED_INT_RE.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}
function parseStrictHandle(raw: string | undefined): bigint | undefined {
  if (raw === undefined || !UNSIGNED_INT_RE.test(raw)) return undefined;
  const value = BigInt(raw);
  return value > 0n && value <= UINT64_MAX ? value : undefined;
}
function parseMeta(parts: readonly string[], wIdx: number, hIdx: number) {
  const gen = parseStrictInt(parts[1], 1, Number.MAX_SAFE_INTEGER);
  const slot = parseStrictInt(parts[2], 0, MAX_SLOT);
  const width = parseStrictInt(parts[wIdx], 1, MAX_TEXTURE_DIM);
  const height = parseStrictInt(parts[hIdx], 1, MAX_TEXTURE_DIM);
  return gen && slot !== undefined && width && height ? { gen, slot, width, height } : undefined;
}

/**
 * Out-of-process in-canvas presenter (`#95`): receives triple-buffered GPU shared textures from
 * `elv-mpv` over a private IPC endpoint (Windows named pipe or macOS Unix domain socket), imports
 * them into Electron `sharedTexture`, acks each imported handle (`I <gen> <slot>`) so the child
 * releases its temporary handle/IOSurface retention, and forwards frames without covering the DOM.
 */
export function createCanvasPresenter<
  TFrame = unknown,
  TImported extends SharedTextureImportedLike = SharedTextureImportedLike,
>(deps: CanvasPresenterDeps<TFrame, TImported>): VideoPresenter {
  const { appWindow } = deps;
  const surface = createSurfaceTracker();
  const slots = new Map<number, TImported>();
  let server: CanvasPipeServerLike | undefined;
  let endpoint: CanvasEndpoint | undefined;
  let listenPromise: Promise<string> | undefined;
  let rejectListen: ((error: Error) => void) | undefined;
  let activeSocket: CanvasPipeSocketLike | undefined;
  let area: PlayerArea | undefined;
  let visible = false;
  let sent = { w: 0, h: 0 };
  let currentGen = 0;
  let surfaceLive = false;
  let rxBuffer = '';
  let droppingLine = false;
  let disposed = false;

  const releaseAllSlots = (): void => {
    for (const imported of slots.values()) safeRun(() => imported.release());
    slots.clear();
  };
  const writeLine = (socket: CanvasPipeSocketLike, line: string): void => {
    if (!disposed && activeSocket === socket) safeRun(() => socket.write(line));
  };
  const resetRx = (): void => {
    rxBuffer = '';
    droppingLine = false;
    sent = { w: 0, h: 0 };
  };

  const syncSize = (): void => {
    if (disposed || !area || appWindow.isDestroyed() || area.width <= 0 || area.height <= 0) return;
    const wc = appWindow.webContents as { getZoomFactor(): number; isDestroyed?(): boolean };
    if (wc.isDestroyed?.()) return;
    let rawZoom = 1;
    try {
      rawZoom = wc.getZoomFactor();
    } catch {
      return;
    }
    const factor = positiveOrOne(rawZoom) * positiveOrOne(deps.getScaleFactor());
    const width = clampDim(area.width * factor);
    const height = clampDim(area.height * factor);
    if (!activeSocket || (width === sent.w && height === sent.h)) return;
    sent = { w: width, h: height };
    writeLine(activeSocket, `R ${width} ${height}\n`);
  };

  const handleSurfaceMessage = (socket: CanvasPipeSocketLike, parts: readonly string[]): void => {
    if (parts.length !== 6) return;
    const meta = parseMeta(parts, 4, 5);
    const handle = parseStrictHandle(parts[3]);
    if (!meta || !handle) return;
    const { gen, slot, width, height } = meta;
    const ack = `I ${gen} ${slot}\n`;
    if (gen < currentGen) {
      writeLine(socket, ack);
      return;
    }

    const imported = withPlatformSurfaceHandle(handle, deps.ioSurfaceResolver, (h) =>
      deps.sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: 'bgra', codedSize: { width, height }, handle: h },
      }),
    );
    writeLine(socket, ack);
    if (!imported) return;

    if (gen > currentGen) {
      releaseAllSlots();
      currentGen = gen;
    } else {
      const existing = slots.get(slot);
      if (existing) safeRun(() => existing.release());
    }
    slots.set(slot, imported);
    if (!surfaceLive) {
      surfaceLive = true;
      surface.created();
    }
  };

  const handleFrameMessage = (socket: CanvasPipeSocketLike, parts: readonly string[]): void => {
    if (parts.length !== 5) return;
    const meta = parseMeta(parts, 3, 4);
    if (!meta) return;
    const { gen, slot } = meta;

    const ack = `A ${gen} ${slot}\n`;
    const imported = gen === currentGen ? slots.get(slot) : undefined;
    const ready = !disposed && visible && !appWindow.isDestroyed() && !appWindow.isMinimized();
    const frame = ready && imported ? deps.getMainFrame() : undefined;
    if (!imported || !frame) {
      writeLine(socket, ack);
      return;
    }

    let pending: Promise<void>;
    try {
      pending = deps.sharedTexture.sendSharedTexture(
        { frame, importedSharedTexture: imported },
        deps.engineId,
      );
    } catch {
      writeLine(socket, ack);
      return;
    }
    void pending.catch(() => undefined).finally(() => writeLine(socket, ack));
  };

  const handleData = (socket: CanvasPipeSocketLike, chunk: Buffer | string): void => {
    if (disposed || activeSocket !== socket) return;
    let incoming = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (droppingLine) {
      const nl = incoming.indexOf('\n');
      if (nl === -1) return;
      incoming = incoming.slice(nl + 1);
      droppingLine = false;
    }
    if (rxBuffer.length + incoming.length > MAX_BUFFER_BYTES && !incoming.includes('\n')) {
      rxBuffer = '';
      droppingLine = true;
      return;
    }
    rxBuffer += incoming;
    let start = 0;
    for (let nl = rxBuffer.indexOf('\n'); nl !== -1; nl = rxBuffer.indexOf('\n', start)) {
      if (nl - start <= MAX_BUFFER_BYTES) {
        const trimmed = rxBuffer.slice(start, nl).trim();
        if (trimmed.length > 0) {
          const parts = trimmed.split(/\s+/);
          if (parts[0] === 'S') handleSurfaceMessage(socket, parts);
          else if (parts[0] === 'F') handleFrameMessage(socket, parts);
        }
      }
      if (activeSocket !== socket || disposed) return;
      start = nl + 1;
    }
    rxBuffer = start > 0 ? rxBuffer.slice(start) : rxBuffer;
    if (rxBuffer.length > MAX_BUFFER_BYTES) {
      rxBuffer = '';
      droppingLine = true;
    }
  };

  const resetClientState = (): void => {
    resetRx();
    currentGen = 0;
    releaseAllSlots();
    if (surfaceLive) {
      surfaceLive = false;
      surface.gone();
    }
  };
  const closeActiveSocket = (): void => {
    const socket = activeSocket;
    activeSocket = undefined;
    if (socket) safeRun(() => socket.destroy());
    resetClientState();
  };
  const handleConnection = (socket: CanvasPipeSocketLike): void => {
    if (disposed || activeSocket !== undefined) {
      safeRun(() => socket.destroy());
      return;
    }
    activeSocket = socket;
    resetRx();
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => handleData(socket, chunk));
    socket.on('close', () => {
      if (activeSocket !== socket) return;
      activeSocket = undefined;
      resetClientState();
    });
    syncSize();
  };
  const ensureServer = (): Promise<string> => {
    if (endpoint && server && !listenPromise) {
      closeActiveSocket();
      return Promise.resolve(endpoint.path);
    }
    if (listenPromise) return listenPromise;
    const nextEndpoint = resolveCanvasEndpoint(deps.createEndpoint, deps.generatePipeName);
    let nextServer: CanvasPipeServerLike | undefined;
    let pending = true;
    const promise = new Promise<string>((resolve, reject) => {
      rejectListen = reject;
      const fail = (error: Error): void => {
        pending = false;
        listenPromise = rejectListen = undefined;
        if (nextServer && server === nextServer) server = undefined;
        if (endpoint === nextEndpoint) endpoint = undefined;
        if (nextServer) safeRun(() => nextServer?.close());
        safeRun(() => nextEndpoint.cleanup());
        reject(error);
      };
      try {
        nextServer = deps.createPipeServer(nextEndpoint.path);
        server = nextServer;
        endpoint = nextEndpoint;
        nextServer.on('connection', handleConnection);
        nextServer.once('error', fail);
        nextServer.listen({ path: nextEndpoint.path, exclusive: true }, () => {
          nextServer?.removeListener('error', fail);
          nextServer?.on('error', () => undefined);
          pending = false;
          listenPromise = rejectListen = undefined;
          if (disposed) {
            fail(new Error('presenter disposed'));
            return;
          }
          safeRun(() => nextEndpoint.onListening?.());
          resolve(nextEndpoint.path);
        });
      } catch (error) {
        nextServer?.removeListener('error', fail);
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (pending) listenPromise = promise;
    return promise;
  };

  for (const event of FOLLOWED_EVENTS) appWindow.on(event, syncSize);
  let stopDisplay = deps.onDisplayChange?.(syncSize);

  return {
    kind: 'canvas',
    coversArea: false,
    async prepare() {
      if (disposed) throw new Error('presenter disposed');
      if (appWindow.isDestroyed()) throw new Error('app window is gone');
      const listeningPath = await ensureServer();
      if (disposed) throw new Error('presenter disposed');
      return [`--elv-canvas-pipe=${listeningPath}`, '--input-vo-keyboard=no'];
    },
    attach(_client: MpvClient) {},
    setArea(next) {
      if (disposed) return;
      area = { ...next };
      visible = next.visible && next.width > 0 && next.height > 0;
      syncSize();
    },
    toggleFullscreen() {
      if (disposed || appWindow.isDestroyed()) return;
      const useSimple = deps.useSimpleFullscreen?.() === true;
      const next = !isAppWindowFullscreen(appWindow);
      const mode = setAppWindowFullscreen(appWindow, next, useSimple);
      if (mode === 'simple') {
        deps.onFullscreenChange?.(next);
        syncSize();
      }
    },
    onEvent: (listener) => surface.onEvent(listener),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const event of FOLLOWED_EVENTS) appWindow.removeListener(event, syncSize);
      stopDisplay?.();
      stopDisplay = undefined;
      closeActiveSocket();
      const [pendingReject, activeServer, activeEndpoint] = [rejectListen, server, endpoint];
      rejectListen = listenPromise = server = endpoint = undefined;
      if (activeServer) safeRun(() => activeServer.close());
      if (activeEndpoint) safeRun(() => activeEndpoint.cleanup());
      pendingReject?.(new Error('presenter disposed'));
      surface.gone();
      surface.clear();
    },
  };
}

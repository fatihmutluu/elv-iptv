import { describe, expect, it, vi } from 'vitest';
import { fakeAppWindow, fakeMpvClient } from '../testing/fake-windows.ts';
import {
  type CanvasPipeServerLike,
  type CanvasPipeSocketLike,
  createCanvasPresenter,
  type SharedTextureImportedLike,
  type SharedTextureImporterLike,
} from './canvas.ts';
import type { PresenterEvent } from './types.ts';

function fakePipeSocket() {
  const listeners = {
    data: new Set<(chunk: Buffer | string) => void>(),
    close: new Set<() => void>(),
    error: new Set<(err: Error) => void>(),
  };
  const written: string[] = [];
  let destroyed = false;

  const socket: CanvasPipeSocketLike = {
    write(chunk: string) {
      if (destroyed) throw new Error('socket destroyed');
      written.push(chunk);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of [...listeners.close]) fn();
    },
    on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void) {
      if (event === 'data') listeners.data.add(listener as (chunk: Buffer | string) => void);
      else if (event === 'close') listeners.close.add(listener as () => void);
      else listeners.error.add(listener as (err: Error) => void);
      return socket;
    },
  };

  return {
    socket,
    written,
    get destroyed() {
      return destroyed;
    },
    push(chunk: Buffer | string) {
      for (const fn of [...listeners.data]) fn(chunk);
    },
    emitClose() {
      for (const fn of [...listeners.close]) fn();
    },
    emitError(err: Error) {
      for (const fn of [...listeners.error]) fn(err);
    },
  };
}

function fakePipeServer(options?: { deferListen?: boolean; failListen?: Error }) {
  const connectionListeners = new Set<(socket: CanvasPipeSocketLike) => void>();
  const errorListeners = new Set<(err: Error) => void>();
  const listenCalls: Array<{ path: string; exclusive: boolean }> = [];
  let closed = false;
  let pendingListening: (() => void) | undefined;

  const server: CanvasPipeServerLike = {
    listen(opts, onListening) {
      listenCalls.push({ ...opts });
      if (options?.failListen) {
        queueMicrotask(() => {
          for (const fn of [...errorListeners]) fn(options.failListen as Error);
        });
        return server;
      }
      if (options?.deferListen) {
        pendingListening = onListening;
        return server;
      }
      queueMicrotask(() => onListening());
      return server;
    },
    on(event: 'connection' | 'error', listener: (...args: never[]) => void) {
      if (event === 'connection') {
        connectionListeners.add(listener as (socket: CanvasPipeSocketLike) => void);
      } else {
        errorListeners.add(listener as (err: Error) => void);
      }
      return server;
    },
    once(event: 'error', listener: (err: Error) => void) {
      const wrapped = (err: Error) => {
        errorListeners.delete(wrapped);
        listener(err);
      };
      if (event === 'error') errorListeners.add(wrapped);
      return server;
    },
    removeListener(event: 'error', listener: (err: Error) => void) {
      if (event === 'error') errorListeners.delete(listener);
      return server;
    },
    close() {
      closed = true;
      return server;
    },
  };

  return {
    server,
    listenCalls,
    get closed() {
      return closed;
    },
    finishListen() {
      pendingListening?.();
      pendingListening = undefined;
    },
    connect(sock: CanvasPipeSocketLike) {
      for (const fn of [...connectionListeners]) fn(sock);
    },
    emitError(err: Error) {
      for (const fn of [...errorListeners]) fn(err);
    },
  };
}

function fakeSharedTexture() {
  const imported: Array<{
    options: Parameters<SharedTextureImporterLike['importSharedTexture']>[0];
    released: number;
    handle: SharedTextureImportedLike;
  }> = [];
  const sends: Array<{
    frame: unknown;
    importedSharedTexture: SharedTextureImportedLike;
    args: unknown[];
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  let autoResolveSend = true;
  let importThrows = false;
  let sendThrowsSync = false;

  const api: SharedTextureImporterLike = {
    importSharedTexture(options) {
      if (importThrows) throw new Error('import failed');
      const record = {
        options,
        released: 0,
        handle: {
          release() {
            record.released += 1;
          },
        },
      };
      imported.push(record);
      return record.handle;
    },
    sendSharedTexture(options, ...args) {
      if (sendThrowsSync) throw new Error('sync send failed');
      return new Promise<void>((resolve, reject) => {
        const entry = { ...options, args, resolve, reject };
        sends.push(entry);
        if (autoResolveSend) resolve();
      });
    },
  };

  return {
    api,
    imported,
    sends,
    setAutoResolveSend(v: boolean) {
      autoResolveSend = v;
    },
    setImportThrows(v: boolean) {
      importThrows = v;
    },
    setSendThrowsSync(v: boolean) {
      sendThrowsSync = v;
    },
  };
}

function setup(opts?: {
  scaleFactor?: number;
  engineId?: string;
  serverOpts?: { deferListen?: boolean; failListen?: Error };
}) {
  const app = fakeAppWindow();
  const pipe = fakePipeServer(opts?.serverOpts);
  const st = fakeSharedTexture();
  let scaleFactor = opts?.scaleFactor ?? 1;
  let mainFrame: unknown = { id: 'main-frame-1' };
  const displayListeners = new Set<() => void>();
  const events: PresenterEvent[] = [];
  const createdPaths: string[] = [];

  const presenter = createCanvasPresenter({
    appWindow: app.window,
    engineId: opts?.engineId ?? 'engine-1',
    sharedTexture: st.api,
    getMainFrame: () => mainFrame,
    getScaleFactor: () => scaleFactor,
    createPipeServer: (pipePath) => {
      createdPaths.push(pipePath);
      return pipe.server;
    },
    onDisplayChange: (listener) => {
      displayListeners.add(listener);
      return () => {
        displayListeners.delete(listener);
      };
    },
  });
  presenter.onEvent((e) => events.push(e));

  return {
    app,
    pipe,
    st,
    events,
    createdPaths,
    presenter,
    setScaleFactor(next: number) {
      scaleFactor = next;
    },
    setMainFrame(next: unknown) {
      mainFrame = next;
    },
    emitDisplayChange() {
      for (const fn of [...displayListeners]) fn();
    },
    displayListenerCount: () => displayListeners.size,
  };
}

describe('createCanvasPresenter', () => {
  it('exposes kind canvas and coversArea false', () => {
    const t = setup();
    expect(t.presenter.kind).toBe('canvas');
    expect(t.presenter.coversArea).toBe(false);
    t.presenter.dispose();
  });

  it('prepare listens exclusively on a unique Windows named pipe and returns canvas args', async () => {
    const t = setup();
    const args = await t.presenter.prepare();
    expect(t.createdPaths).toHaveLength(1);
    const pipePath = t.createdPaths[0] ?? '';
    expect(pipePath).toMatch(/^\\\\\.\\pipe\\elv-mpv-canvas-[0-9a-f]{16}$/);
    expect(t.pipe.listenCalls).toEqual([{ path: pipePath, exclusive: true }]);
    expect(args).toEqual([`--elv-canvas-pipe=${pipePath}`, '--input-vo-keyboard=no']);
    t.presenter.dispose();
  });

  it('reuses the listening pipe on a second prepare and cleans up stale client state', async () => {
    const t = setup();
    const firstArgs = await t.presenter.prepare();
    const sock1 = fakePipeSocket();
    t.pipe.connect(sock1.socket);
    sock1.push('S 1 0 12345 1280 720\n');
    expect(t.events).toEqual([{ type: 'surface', change: 'created' }]);
    expect(t.st.imported[0]?.released).toBe(0);

    const secondArgs = await t.presenter.prepare();
    expect(secondArgs).toEqual(firstArgs);
    expect(t.createdPaths).toHaveLength(1);
    expect(sock1.destroyed).toBe(true);
    expect(t.st.imported[0]?.released).toBe(1);
    expect(t.events).toEqual([
      { type: 'surface', change: 'created' },
      { type: 'surface', change: 'destroyed' },
    ]);

    const sock2 = fakePipeSocket();
    t.pipe.connect(sock2.socket);
    sock2.push('S 1 0 99999 1280 720\n');
    expect(t.events).toEqual([
      { type: 'surface', change: 'created' },
      { type: 'surface', change: 'destroyed' },
      { type: 'surface', change: 'created' },
    ]);
    t.presenter.dispose();
  });

  it('rejects prepare when disposed, window destroyed, listen fails, or disposed mid-listen', async () => {
    const t1 = setup();
    t1.presenter.dispose();
    await expect(t1.presenter.prepare()).rejects.toThrow(/disposed/);

    const t2 = setup();
    t2.app.state.destroyed = true;
    await expect(t2.presenter.prepare()).rejects.toThrow(/gone/);
    t2.presenter.dispose();

    const t3 = setup({ serverOpts: { failListen: new Error('EACCES') } });
    await expect(t3.presenter.prepare()).rejects.toThrow('EACCES');
    expect(t3.pipe.closed).toBe(true);
    t3.presenter.dispose();

    const t4 = setup({ serverOpts: { deferListen: true } });
    const pending = t4.presenter.prepare();
    t4.presenter.dispose();
    // Do NOT invoke finishListen(): real net.Server.close() before 'listening' emits neither event
    await expect(pending).rejects.toThrow(/disposed/);
    expect(t4.pipe.closed).toBe(true);
  });

  it('accepts at most one client socket and destroys extra connections immediately', async () => {
    const t = setup();
    await t.presenter.prepare();
    const sock1 = fakePipeSocket();
    const sock2 = fakePipeSocket();
    t.pipe.connect(sock1.socket);
    t.pipe.connect(sock2.socket);

    expect(sock1.destroyed).toBe(false);
    expect(sock2.destroyed).toBe(true);
    t.presenter.dispose();
  });

  it('computes clamped physical pixel dimensions and sends R on area, window, and display changes', async () => {
    const t = setup({ scaleFactor: 1.5 });
    t.app.state.zoom = 1.25;
    await t.presenter.prepare();

    // Area set before connect is delivered upon connection
    t.presenter.setArea({ x: 10, y: 20, width: 800, height: 450, visible: true });
    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);
    expect(sock.written).toEqual(['R 1500 844\n']);

    // Same dimensions do not resend R
    t.presenter.setArea({ x: 30, y: 40, width: 800, height: 450, visible: true });
    expect(sock.written).toEqual(['R 1500 844\n']);

    // Clamp minimum to 16 and maximum to 4096
    t.presenter.setArea({ x: 0, y: 0, width: 4, height: 5000, visible: true });
    expect(sock.written).toEqual(['R 1500 844\n', 'R 16 4096\n']);

    // Display scale change pushes updated R
    t.presenter.setArea({ x: 0, y: 0, width: 640, height: 360, visible: true });
    expect(sock.written.at(-1)).toBe('R 1200 675\n');
    t.setScaleFactor(2);
    t.emitDisplayChange();
    expect(sock.written.at(-1)).toBe('R 1600 900\n');

    // Window events push updated R when zoom or scale changes
    t.app.state.zoom = 1;
    t.app.emit('resize');
    expect(sock.written.at(-1)).toBe('R 1280 720\n');

    t.setScaleFactor(1);
    t.app.emit('move');
    expect(sock.written.at(-1)).toBe('R 640 360\n');

    t.setScaleFactor(1.5);
    t.app.emit('enter-full-screen');
    expect(sock.written.at(-1)).toBe('R 960 540\n');

    t.setScaleFactor(1);
    t.app.emit('leave-full-screen');
    expect(sock.written.at(-1)).toBe('R 640 360\n');

    t.setScaleFactor(2);
    t.app.emit('restore');
    expect(sock.written.at(-1)).toBe('R 1280 720\n');

    t.setScaleFactor(1.5);
    t.app.emit('maximize');
    expect(sock.written.at(-1)).toBe('R 960 540\n');

    t.setScaleFactor(1);
    t.app.emit('unmaximize');
    expect(sock.written.at(-1)).toBe('R 640 360\n');

    // Destroyed webContents or throwing getZoomFactor does not throw during resize teardown
    let wcDestroyed = true;
    Object.assign(t.app.window.webContents, { isDestroyed: () => wcDestroyed });
    t.setScaleFactor(2);
    expect(() => t.app.emit('resize')).not.toThrow();
    expect(sock.written.at(-1)).toBe('R 640 360\n');

    wcDestroyed = false;
    Object.assign(t.app.window.webContents, {
      getZoomFactor: () => {
        throw new Error('webContents gone');
      },
    });
    expect(() => t.app.emit('resize')).not.toThrow();
    expect(sock.written.at(-1)).toBe('R 640 360\n');

    t.presenter.dispose();
  });

  it('imports S handles as 8-byte LE Buffers, acks every S with I <gen> <slot>, tracks generations, and emits surface created once', async () => {
    const t = setup();
    await t.presenter.prepare();
    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);

    const bigHandle = 0x0000_1234_5678_9abcn;
    sock.push(`S 1 0 ${bigHandle.toString()} 1920 1080\r\n`);
    sock.push('S 1 1 200 1920 1080\n');
    sock.push('S 1 2 300 1920 1080\n');

    expect(t.st.imported).toHaveLength(3);
    const first = t.st.imported[0];
    expect(first?.options.textureInfo.pixelFormat).toBe('bgra');
    expect(first?.options.textureInfo.codedSize).toEqual({ width: 1920, height: 1080 });
    expect(first?.options.textureInfo.handle.ntHandle.length).toBe(8);
    expect(first?.options.textureInfo.handle.ntHandle.readBigUInt64LE(0)).toBe(bigHandle);
    expect(t.events).toEqual([{ type: 'surface', change: 'created' }]);
    expect(sock.written).toEqual(['I 1 0\n', 'I 1 1\n', 'I 1 2\n']);

    // New generation releases all generation 1 textures and acks
    sock.push('S 2 0 400 1280 720\n');
    expect(t.st.imported[0]?.released).toBe(1);
    expect(t.st.imported[1]?.released).toBe(1);
    expect(t.st.imported[2]?.released).toBe(1);
    expect(t.st.imported[3]?.released).toBe(0);
    expect(sock.written.at(-1)).toBe('I 2 0\n');
    // Surface stays live across resizes without duplicate created events
    expect(t.events).toEqual([{ type: 'surface', change: 'created' }]);

    // Re-importing same slot in same generation releases old slot texture and acks
    sock.push('S 2 0 401 1280 720\n');
    expect(t.st.imported[3]?.released).toBe(1);
    expect(t.st.imported[4]?.released).toBe(0);
    expect(sock.written.at(-1)).toBe('I 2 0\n');

    // Stale generation is not imported, but still acks I so child closes the parent NT handle
    sock.push('S 1 0 500 1280 720\n');
    expect(t.st.imported).toHaveLength(5);
    expect(sock.written.at(-1)).toBe('I 1 0\n');

    t.presenter.dispose();
  });

  it('ignores malformed lines, out-of-range fields, import errors, and oversized lines safely', async () => {
    const t = setup();
    await t.presenter.prepare();
    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);

    const badLines = [
      '',
      'X 1 0 100 640 360',
      'S 0 0 100 640 360', // gen < 1
      'S 1 8 100 640 360', // slot > 7
      'S 1 -1 100 640 360', // negative slot
      'S 1 0 0 640 360', // zero handle
      'S 1 0 18446744073709551616 640 360', // > uint64 max
      'S 1 0 0x10 640 360', // hex not decimal
      'S 1 0 100 0 360', // width < 1
      'S 1 0 100 640 8193', // height > 8192
      'S 1 0 100 640', // too few args
      'F 0 0 640 360', // gen < 1
      'F 1 9 640 360', // slot > 7
      'F 1 0 640', // too few args
    ];
    for (const line of badLines) sock.push(`${line}\n`);
    expect(t.st.imported).toHaveLength(0);
    expect(sock.written).toEqual([]);

    // Oversized unterminated chunk is dropped safely, next valid line still parses
    sock.push('A'.repeat(20_000));
    sock.push('garbage\nS 1 ');
    sock.push('0 42 640 360\n');
    expect(t.st.imported).toHaveLength(1);

    // Import throwing does not crash and still sends I ack so child closes the parent NT handle
    t.st.setImportThrows(true);
    sock.push('S 1 1 43 640 360\n');
    expect(t.st.imported).toHaveLength(1);
    expect(sock.written.at(-1)).toBe('I 1 1\n');
    t.st.setImportThrows(false);

    t.presenter.dispose();
  });

  it('sends F frames to mainFrame with engineId and acks in finally, swallowing send errors', async () => {
    const t = setup({ engineId: 'engine-42' });
    t.st.setAutoResolveSend(false);
    await t.presenter.prepare();
    t.presenter.setArea({ x: 0, y: 0, width: 640, height: 360, visible: true });

    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);
    sock.written.length = 0;

    sock.push('S 1 0 777 640 360\n');
    expect(sock.written).toEqual(['I 1 0\n']);
    sock.written.length = 0;
    sock.push('F 1 0 640 360\n');

    expect(t.st.sends).toHaveLength(1);
    expect(t.st.sends[0]?.frame).toEqual({ id: 'main-frame-1' });
    expect(t.st.sends[0]?.importedSharedTexture).toBe(t.st.imported[0]?.handle);
    expect(t.st.sends[0]?.args).toEqual(['engine-42']);
    // Ack is NOT sent until sendSharedTexture settles
    expect(sock.written).toEqual([]);

    t.st.sends[0]?.resolve();
    await vi.waitFor(() => expect(sock.written).toEqual(['A 1 0\n']));

    // Rejected sendSharedTexture is swallowed and still acks
    sock.push('F 1 0 640 360\n');
    expect(t.st.sends).toHaveLength(2);
    t.st.sends[1]?.reject(new Error('renderer gone'));
    await vi.waitFor(() => expect(sock.written).toEqual(['A 1 0\n', 'A 1 0\n']));

    // Synchronous throw from sendSharedTexture is caught and immediately acks
    t.st.setSendThrowsSync(true);
    sock.push('F 1 0 640 360\n');
    expect(sock.written).toEqual(['A 1 0\n', 'A 1 0\n', 'A 1 0\n']);
    t.st.setSendThrowsSync(false);

    t.presenter.dispose();
  });

  it('immediately acks F without sending when hidden, minimized, stale gen, missing slot, or missing frame', async () => {
    const t = setup();
    await t.presenter.prepare();
    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);
    sock.push('S 2 0 100 640 360\n');

    // Hidden (area never set)
    sock.push('F 2 0 640 360\n');
    expect(sock.written.at(-1)).toBe('A 2 0\n');
    expect(t.st.sends).toHaveLength(0);

    // Zero-sized area
    t.presenter.setArea({ x: 0, y: 0, width: 0, height: 360, visible: true });
    sock.push('F 2 0 640 360\n');
    expect(sock.written.at(-1)).toBe('A 2 0\n');
    expect(t.st.sends).toHaveLength(0);

    // Visible but wrong gen
    t.presenter.setArea({ x: 0, y: 0, width: 640, height: 360, visible: true });
    sock.push('F 1 0 640 360\n');
    expect(sock.written.at(-1)).toBe('A 1 0\n');
    expect(t.st.sends).toHaveLength(0);

    // Visible but unimported slot
    sock.push('F 2 1 640 360\n');
    expect(sock.written.at(-1)).toBe('A 2 1\n');
    expect(t.st.sends).toHaveLength(0);

    // Minimized window
    t.app.state.minimized = true;
    sock.push('F 2 0 640 360\n');
    expect(sock.written.at(-1)).toBe('A 2 0\n');
    expect(t.st.sends).toHaveLength(0);
    t.app.state.minimized = false;

    // Missing mainFrame
    t.setMainFrame(null);
    sock.push('F 2 0 640 360\n');
    expect(sock.written.at(-1)).toBe('A 2 0\n');
    expect(t.st.sends).toHaveLength(0);
    t.setMainFrame({ id: 'main-frame-1' });

    // Destroyed appWindow
    t.app.state.destroyed = true;
    sock.push('F 2 0 640 360\n');
    expect(sock.written.at(-1)).toBe('A 2 0\n');
    expect(t.st.sends).toHaveLength(0);

    t.presenter.dispose();
  });

  it('releases textures and emits surface destroyed when child socket closes', async () => {
    const t = setup();
    await t.presenter.prepare();
    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);
    sock.push('S 1 0 111 640 360\nS 1 1 222 640 360\n');
    expect(t.events).toEqual([{ type: 'surface', change: 'created' }]);

    sock.emitClose();
    expect(t.st.imported[0]?.released).toBe(1);
    expect(t.st.imported[1]?.released).toBe(1);
    expect(t.events).toEqual([
      { type: 'surface', change: 'created' },
      { type: 'surface', change: 'destroyed' },
    ]);

    t.presenter.dispose();
  });

  it('toggles appWindow fullscreen directly and ignores attach/toggle after dispose or destroy', () => {
    const t = setup();
    t.presenter.attach(fakeMpvClient().client);

    t.presenter.toggleFullscreen();
    expect(t.app.state.fullscreenCalls).toEqual([true]);
    t.presenter.toggleFullscreen();
    expect(t.app.state.fullscreenCalls).toEqual([true, false]);

    t.app.state.destroyed = true;
    t.presenter.toggleFullscreen();
    expect(t.app.state.fullscreenCalls).toEqual([true, false]);

    t.app.state.destroyed = false;
    t.presenter.dispose();
    t.presenter.toggleFullscreen();
    expect(t.app.state.fullscreenCalls).toEqual([true, false]);
  });

  it('dispose closes server and socket, removes all listeners, releases textures, and is idempotent', async () => {
    const t = setup();
    await t.presenter.prepare();
    const sock = fakePipeSocket();
    t.pipe.connect(sock.socket);
    sock.push('S 1 0 555 640 360\n');

    expect(t.app.listenerCount()).toBeGreaterThan(0);
    expect(t.displayListenerCount()).toBe(1);

    t.presenter.dispose();
    t.presenter.dispose();

    expect(t.pipe.closed).toBe(true);
    expect(sock.destroyed).toBe(true);
    expect(t.app.listenerCount()).toBe(0);
    expect(t.displayListenerCount()).toBe(0);
    expect(t.st.imported[0]?.released).toBe(1);
    expect(t.events).toEqual([
      { type: 'surface', change: 'created' },
      { type: 'surface', change: 'destroyed' },
    ]);
  });
});

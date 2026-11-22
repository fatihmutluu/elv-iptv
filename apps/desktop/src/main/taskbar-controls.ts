import { deflateSync } from 'node:zlib';

/** Playback action dispatched when the user clicks a Windows taskbar thumbnail button (`#410`). */
export type TaskbarAction = 'play-pause' | 'channel-up' | 'channel-down';

/** Electron `ProgressBarOptions['mode']` subset used for Windows taskbar progress. */
export type TaskbarProgressMode = 'none' | 'normal' | 'indeterminate' | 'error' | 'paused';

/** Electron `ThumbarButton` subset accepted by {@link TaskbarWindow.setThumbarButtons}. */
export interface ThumbarButtonLike<TIcon = unknown> {
  readonly tooltip: string;
  readonly icon: TIcon;
  readonly flags: ('enabled' | 'disabled')[];
  readonly click: () => void;
}

/** Minimal `BrowserWindow` surface used by {@link createTaskbarController}. */
export interface TaskbarWindow<TIcon = unknown> {
  setProgressBar(progress: number, options?: { mode: TaskbarProgressMode }): void;
  setThumbarButtons(buttons: ThumbarButtonLike<TIcon>[]): boolean;
  isDestroyed(): boolean;
}

/** Icon set supplied to {@link createTaskbarController} (e.g. `NativeImage` on Electron). */
export interface TaskbarIcons<TIcon = unknown> {
  readonly previous: TIcon;
  readonly play: TIcon;
  readonly pause: TIcon;
  readonly next: TIcon;
}

/** Playback snapshot passed to {@link TaskbarController.updatePlayback}. */
export interface TaskbarPlaybackSnapshot {
  readonly active: boolean;
  readonly isVod: boolean;
  readonly paused: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly canStep: boolean;
}

/** Controller driving Windows taskbar progress and thumbnail transport controls (`#410`). */
export interface TaskbarController {
  updatePlayback(snapshot: TaskbarPlaybackSnapshot): void;
  clear(): void;
}

/** Collaborators injected into {@link createTaskbarController}. */
export interface TaskbarControllerDeps<TIcon = unknown> {
  readonly window: TaskbarWindow<TIcon>;
  readonly platform: NodeJS.Platform;
  readonly icons: TaskbarIcons<TIcon>;
  readonly onAction: (action: TaskbarAction) => void;
}

const PROGRESS_DELTA_THRESHOLD = 0.005;
const ICON_SIZE = 16;

/**
 * Creates a Windows-only Electron taskbar controller (`#410`).
 * Strictly a no-op on macOS and Linux. On Windows, throttles tiny `< 0.5%` VOD progress updates
 * (unless the play/pause mode changes) and updates thumbar buttons only when state actually changes.
 */
export function createTaskbarController<TIcon = unknown>(
  deps: TaskbarControllerDeps<TIcon>,
): TaskbarController {
  const { window, platform, icons, onAction } = deps;
  if (platform !== 'win32') {
    return {
      updatePlayback: () => undefined,
      clear: () => undefined,
    };
  }

  let lastProgress: number | undefined;
  let lastMode: 'normal' | 'paused' | undefined;
  let lastButtonsKey: string | undefined;

  const setCleared = (): void => {
    if (window.isDestroyed()) return;
    if (lastProgress !== undefined && lastProgress !== -1) {
      window.setProgressBar(-1);
    }
    lastProgress = -1;
    lastMode = undefined;
    if (lastButtonsKey !== undefined && lastButtonsKey !== 'cleared') {
      window.setThumbarButtons([]);
    }
    lastButtonsKey = 'cleared';
  };

  return {
    updatePlayback(snapshot) {
      if (window.isDestroyed()) return;
      if (!snapshot.active) {
        setCleared();
        return;
      }

      if (
        snapshot.isVod &&
        Number.isFinite(snapshot.durationMs) &&
        snapshot.durationMs > 0 &&
        Number.isFinite(snapshot.positionMs)
      ) {
        const ratio = Math.max(0, Math.min(1, snapshot.positionMs / snapshot.durationMs));
        const mode: 'normal' | 'paused' = snapshot.paused ? 'paused' : 'normal';
        const modeChanged = lastMode !== mode;
        const deltaLargeEnough =
          lastProgress === undefined ||
          lastProgress < 0 ||
          Math.abs(ratio - lastProgress) >= PROGRESS_DELTA_THRESHOLD;
        if (modeChanged || deltaLargeEnough) {
          window.setProgressBar(ratio, { mode });
          lastProgress = ratio;
          lastMode = mode;
        }
      } else if (lastProgress !== -1) {
        window.setProgressBar(-1);
        lastProgress = -1;
        lastMode = undefined;
      }

      const buttonsKey = `${snapshot.paused ? '1' : '0'}:${snapshot.canStep ? '1' : '0'}`;
      if (buttonsKey !== lastButtonsKey) {
        lastButtonsKey = buttonsKey;
        const stepFlags: ('enabled' | 'disabled')[] = snapshot.canStep ? ['enabled'] : ['disabled'];
        window.setThumbarButtons([
          {
            tooltip: 'Previous',
            icon: icons.previous,
            flags: stepFlags,
            click: () => onAction('channel-down'),
          },
          {
            tooltip: snapshot.paused ? 'Play' : 'Pause',
            icon: snapshot.paused ? icons.play : icons.pause,
            flags: ['enabled'],
            click: () => onAction('play-pause'),
          },
          {
            tooltip: 'Next',
            icon: icons.next,
            flags: stepFlags,
            click: () => onAction('channel-up'),
          },
        ]);
      }
    },
    clear() {
      setCleared();
    },
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeMonochromePng16(pixel: (x: number, y: number) => boolean): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ICON_SIZE, 0);
  ihdr.writeUInt32BE(ICON_SIZE, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + ICON_SIZE * 4;
  const raw = Buffer.alloc(stride * ICON_SIZE);
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0; // filter: None
    for (let x = 0; x < ICON_SIZE; x += 1) {
      if (!pixel(x, y)) continue;
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = 0xff;
      raw[offset + 1] = 0xff;
      raw[offset + 2] = 0xff;
      raw[offset + 3] = 0xff;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Builds crisp 16×16 monochrome RGBA PNG buffers in memory for Windows thumbar playback controls. */
export function createTaskbarIconPngs(): TaskbarIcons<Buffer> {
  const inRightTriangle = (x: number, y: number, left: number, right: number): boolean => {
    if (x < left || x > right || y < 2 || y > 13) return false;
    const halfSpan = Math.abs(y - 7.5);
    const progress = (x - left) / Math.max(1, right - left);
    return halfSpan <= (1 - progress) * 5.6;
  };
  const inLeftTriangle = (x: number, y: number, left: number, right: number): boolean => {
    if (x < left || x > right || y < 2 || y > 13) return false;
    const halfSpan = Math.abs(y - 7.5);
    const progress = (right - x) / Math.max(1, right - left);
    return halfSpan <= (1 - progress) * 5.6;
  };

  return {
    play: encodeMonochromePng16((x, y) => inRightTriangle(x, y, 4, 12)),
    pause: encodeMonochromePng16(
      (x, y) => y >= 2 && y <= 13 && ((x >= 3 && x <= 5) || (x >= 10 && x <= 12)),
    ),
    previous: encodeMonochromePng16(
      (x, y) => (y >= 2 && y <= 13 && x >= 2 && x <= 3) || inLeftTriangle(x, y, 5, 13),
    ),
    next: encodeMonochromePng16(
      (x, y) => inRightTriangle(x, y, 2, 10) || (y >= 2 && y <= 13 && x >= 12 && x <= 13),
    ),
  };
}

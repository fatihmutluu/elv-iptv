import { deflateSync } from 'node:zlib';
import { type TrayLabels, WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import { WINDOW_TITLE } from './window-options.ts';

/** Minimal menu item descriptor passed to `Menu.buildFromTemplate`. */
export interface TrayMenuItemTemplate {
  readonly label?: string;
  readonly type?: 'normal' | 'separator';
  readonly click?: () => void;
}

/** Minimal Electron `Tray` surface used by {@link createTrayController}. */
export interface TrayLike {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click' | 'double-click', listener: () => void): unknown;
  isDestroyed(): boolean;
  destroy(): void;
}

/** Minimal `BrowserWindow` surface used by {@link restoreWindowFromTray}. */
export interface TrayRestorableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible?(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

/** Collaborators injected into {@link createTrayController}. */
export interface TrayControllerDeps<TIcon = unknown> {
  readonly icon: TIcon;
  readonly tooltip?: string;
  readonly labels?: TrayLabels;
  readonly createTray: (icon: TIcon) => TrayLike;
  readonly buildMenu: (template: TrayMenuItemTemplate[]) => unknown;
  readonly onRestore: () => void;
  readonly onQuit: () => void;
  readonly log?: (line: string) => void;
}

/** Handle returned by {@link createTrayController} (`#158`). */
export interface TrayController {
  /** Ensures the tray icon exists and returns `true` when active, or `false` if tray is unavailable. */
  ensureShown(): boolean;
  isShown(): boolean;
  setLabels(labels: TrayLabels): void;
  destroy(): void;
}

/**
 * Pure testable system tray controller wrapping Electron `Tray` + `Menu` (`Restore`, `Quit`) (`#158`).
 * Ensures idempotent show/destroy so no zombie tray icon remains on Windows exit, and guards tray
 * construction so headless/Wayland Linux environments without a StatusNotifier host fail cleanly.
 */
export function createTrayController<TIcon = unknown>(
  deps: TrayControllerDeps<TIcon>,
): TrayController {
  let tray: TrayLike | undefined;
  let unavailable = false;
  let labels: TrayLabels = deps.labels ?? {
    restore: `Restore ${WINDOW_TITLE}`,
    quit: 'Quit',
  };
  const tooltip = deps.tooltip ?? WINDOW_TITLE;

  const buildContextMenu = (): unknown =>
    deps.buildMenu([
      { label: labels.restore, click: () => deps.onRestore() },
      { type: 'separator' },
      { label: labels.quit, click: () => deps.onQuit() },
    ]);

  return {
    ensureShown() {
      if (unavailable) return false;
      if (tray && !tray.isDestroyed()) return true;
      let instance: TrayLike | undefined;
      try {
        instance = deps.createTray(deps.icon);
        instance.setToolTip(tooltip);
        instance.setContextMenu(buildContextMenu());
        instance.on('click', () => deps.onRestore());
        instance.on('double-click', () => deps.onRestore());
        tray = instance;
        return true;
      } catch (err) {
        unavailable = true;
        if (instance && !instance.isDestroyed()) {
          try {
            instance.destroy();
          } catch {
            // Best-effort cleanup of partially initialized tray instance.
          }
        }
        tray = undefined;
        const reason = err instanceof Error ? err.message : String(err);
        deps.log?.(
          `tray: system tray unavailable (${reason}); disabling close-to-tray for this session`,
        );
        return false;
      }
    },
    isShown() {
      return tray !== undefined && !tray.isDestroyed();
    },
    setLabels(nextLabels: TrayLabels) {
      labels = nextLabels;
      if (tray && !tray.isDestroyed()) {
        try {
          tray.setContextMenu(buildContextMenu());
        } catch {
          // Ignore menu update failures on transient tray teardowns.
        }
      }
    },
    destroy() {
      if (tray && !tray.isDestroyed()) {
        try {
          tray.destroy();
        } catch {
          // Best-effort tray disposal.
        }
      }
      tray = undefined;
    },
  };
}

/** Restores a minimized or hidden desktop window, focuses it, and emits `window:restored` to the renderer. */
export function restoreWindowFromTray(win: TrayRestorableWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!win.webContents.isDestroyed()) {
    win.webContents.send(WINDOW_CHANNELS.windowRestored);
  }
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
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generates a crisp built-in RGBA PNG icon (16×16 or 32×32) for the system tray in memory,
 * avoiding any external image file lookup or missing-asset crash (`#158`).
 */
export function createTrayIconPng(size: 16 | 32 = 32): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  const margin = size === 32 ? 2 : 1;
  const corner = size === 32 ? 6 : 3;
  const playLeft = Math.round(size * 0.36);
  const playRight = Math.round(size * 0.72);
  const playTop = Math.round(size * 0.27);
  const playBottom = Math.round(size * 0.73);
  const centerY = (size - 1) / 2;

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      const inBox = x >= margin && x < size - margin && y >= margin && y < size - margin;
      if (!inBox) continue;
      const dx = Math.max(margin + corner - x, x - (size - 1 - margin - corner), 0);
      const dy = Math.max(margin + corner - y, y - (size - 1 - margin - corner), 0);
      if (dx * dx + dy * dy > corner * corner) continue;

      let isPlay = false;
      if (x >= playLeft && x <= playRight && y >= playTop && y <= playBottom) {
        const progress = (x - playLeft) / Math.max(1, playRight - playLeft);
        const maxHalf = (1 - progress) * ((playBottom - playTop) / 2);
        isPlay = Math.abs(y - centerY) <= maxHalf;
      }

      const offset = rowOffset + 1 + x * 4;
      if (isPlay) {
        raw[offset] = 0xff;
        raw[offset + 1] = 0xff;
        raw[offset + 2] = 0xff;
        raw[offset + 3] = 0xff;
      } else {
        // Obsidian Crimson accent badge (#E11D48)
        raw[offset] = 0xe1;
        raw[offset + 1] = 0x1d;
        raw[offset + 2] = 0x48;
        raw[offset + 3] = 0xff;
      }
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

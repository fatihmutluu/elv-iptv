import { describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import {
  createTrayController,
  createTrayIconPng,
  restoreWindowFromTray,
  type TrayLike,
  type TrayMenuItemTemplate,
} from './tray.ts';

function fakeTray() {
  let destroyed = false;
  let tooltip = '';
  let menu: unknown;
  const listeners = new Map<string, Set<() => void>>();
  const tray: TrayLike = {
    setToolTip(tip) {
      tooltip = tip;
    },
    setContextMenu(m) {
      menu = m;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
  };
  return {
    tray,
    getTooltip: () => tooltip,
    getMenu: () => menu,
    isDestroyed: () => destroyed,
    emit: (event: 'click' | 'double-click') => {
      for (const l of [...(listeners.get(event) ?? [])]) l();
    },
  };
}

describe('tray controller (#158)', () => {
  it('generates a valid in-memory PNG icon buffer without external file dependencies', () => {
    const png16 = createTrayIconPng(16);
    const png32 = createTrayIconPng(32);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png16.subarray(0, 8).equals(sig)).toBe(true);
    expect(png32.subarray(0, 8).equals(sig)).toBe(true);
    expect(png16.readUInt32BE(16)).toBe(16);
    expect(png16.readUInt32BE(20)).toBe(16);
    expect(png32.readUInt32BE(16)).toBe(32);
    expect(png32.readUInt32BE(20)).toBe(32);
  });

  it('creates tray idempotently, handles click/double-click/Restore/Quit, and destroys cleanly', () => {
    const created: Array<ReturnType<typeof fakeTray>> = [];
    let builtTemplates: readonly TrayMenuItemTemplate[] = [];
    const onRestore = vi.fn();
    const onQuit = vi.fn();

    const controller = createTrayController({
      icon: { kind: 'fake-icon' },
      createTray: () => {
        const ft = fakeTray();
        created.push(ft);
        return ft.tray;
      },
      buildMenu: (template) => {
        builtTemplates = template;
        return { template };
      },
      onRestore,
      onQuit,
    });

    expect(controller.isShown()).toBe(false);
    controller.ensureShown();
    controller.ensureShown();
    expect(created).toHaveLength(1);
    expect(controller.isShown()).toBe(true);
    expect(created[0]?.getTooltip()).toBe('ELV IPTV');

    // Click and double-click both restore
    created[0]?.emit('click');
    created[0]?.emit('double-click');
    expect(onRestore).toHaveBeenCalledTimes(2);

    // Context menu Restore and Quit items work
    const restoreItem = builtTemplates.find((i) => i.label?.includes('Restore'));
    const quitItem = builtTemplates.find((i) => i.label?.includes('Quit'));
    expect(restoreItem).toBeDefined();
    expect(quitItem).toBeDefined();
    restoreItem?.click?.();
    quitItem?.click?.();
    expect(onRestore).toHaveBeenCalledTimes(3);
    expect(onQuit).toHaveBeenCalledTimes(1);

    // Destroy cleans up and is idempotent
    controller.destroy();
    expect(created[0]?.isDestroyed()).toBe(true);
    expect(controller.isShown()).toBe(false);
    controller.destroy();

    // Can re-show after destroy
    controller.ensureShown();
    expect(created).toHaveLength(2);
    expect(controller.isShown()).toBe(true);
    controller.destroy();
  });

  it('restores a hidden or minimized window, focuses it, and notifies renderer via window:restored', () => {
    const calls: string[] = [];
    const sent: Array<{ channel: string; args: unknown[] }> = [];
    const win = {
      isDestroyed: () => false,
      isMinimized: () => true,
      isVisible: () => false,
      show: () => calls.push('show'),
      restore: () => calls.push('restore'),
      focus: () => calls.push('focus'),
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
      },
    };

    restoreWindowFromTray(win);
    expect(calls).toEqual(['restore', 'show', 'focus']);
    expect(sent).toEqual([{ channel: WINDOW_CHANNELS.windowRestored, args: [] }]);
  });

  it('updates tray context menu labels dynamically via setLabels before and after ensureShown (LOW #11)', () => {
    const created: Array<ReturnType<typeof fakeTray>> = [];
    const builtTemplates: TrayMenuItemTemplate[][] = [];
    const onRestore = vi.fn();
    const onQuit = vi.fn();

    const controller = createTrayController({
      icon: { kind: 'fake-icon' },
      createTray: () => {
        const ft = fakeTray();
        created.push(ft);
        return ft.tray;
      },
      buildMenu: (template) => {
        builtTemplates.push([...template]);
        return { template };
      },
      onRestore,
      onQuit,
    });

    // Updating labels before tray is shown persists them for the initial menu build
    controller.setLabels({ restore: 'ELV IPTV Penceresini Geri Yükle', quit: 'Çıkış' });
    controller.ensureShown();
    expect(builtTemplates).toHaveLength(1);
    expect(builtTemplates[0]?.map((i) => i.label ?? i.type)).toEqual([
      'ELV IPTV Penceresini Geri Yükle',
      'separator',
      'Çıkış',
    ]);

    // Updating labels while tray is visible rebuilds and applies the context menu live
    controller.setLabels({ restore: 'Restore ELV IPTV', quit: 'Quit' });
    expect(builtTemplates).toHaveLength(2);
    expect(builtTemplates[1]?.map((i) => i.label ?? i.type)).toEqual([
      'Restore ELV IPTV',
      'separator',
      'Quit',
    ]);
    expect(created[0]?.getMenu()).toEqual({ template: builtTemplates[1] });

    controller.destroy();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  clampZoomLevel,
  isAspectRatioLockFlag,
  isMinimizeToTrayFlag,
  isZoomLevel,
  MAX_WINDOW_ZOOM_LEVEL,
  MIN_WINDOW_ZOOM_LEVEL,
  WINDOW_CHANNELS,
  ZOOM_LEVEL_STEP,
} from '../shared/window-ipc.ts';
import type { TrustedSenderEventLike } from './trusted-sender.ts';
import {
  registerWindowIpc,
  type WindowIpcMainLike,
  type WindowIpcWindowLike,
} from './window-ipc.ts';

type Handler = (event: TrustedSenderEventLike & { sender: unknown }, ...args: unknown[]) => unknown;

function trustedFrame(url = 'app://elv/index.html') {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = frame;
  return frame;
}

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain: WindowIpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
  };
  return {
    ipcMain,
    handlers,
    invoke: (channel: string, sender: unknown, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({ sender, senderFrame: trustedFrame() }, ...args)),
    invokeWithEvent: (
      channel: string,
      event: TrustedSenderEventLike & { sender: unknown },
      ...args: unknown[]
    ) => Promise.resolve(handlers.get(channel)?.(event, ...args)),
  };
}

function fakeWindow() {
  let destroyed = false;
  const setCalls: unknown[][] = [];
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const sender = { id: 1 };
  const win: WindowIpcWindowLike = {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel, ...args) => {
        sent.push({ channel, args });
      },
      setZoomLevel: (level: number) => {
        setCalls.push(['setZoomLevel', level]);
      },
    },
  };
  return {
    win,
    sender,
    setCalls,
    sent,
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('window-ipc (#332, #158)', () => {
  it('exposes exact frozen WINDOW_CHANNELS and payload guards', () => {
    expect(Object.isFrozen(WINDOW_CHANNELS)).toBe(true);
    expect(WINDOW_CHANNELS).toEqual({
      setAspectRatioLock: 'window:set-aspect-ratio-lock',
      setMinimizeToTray: 'window:set-minimize-to-tray',
      windowRestored: 'window:restored',
      hiddenToTray: 'window:hidden-to-tray',
      openPopout: 'window:open-popout',
      closePopout: 'window:close-popout',
      getPopoutPayload: 'window:get-popout-payload',
      popoutPayload: 'window:popout-payload',
      dockPopout: 'window:dock-popout',
      popoutDocked: 'window:popout-docked',
      openExternalUrl: 'window:open-external-url',
      getZoomLevel: 'window:get-zoom-level',
      setZoomLevel: 'window:set-zoom-level',
      zoomLevelChanged: 'window:zoom-level-changed',
    });
    expect(MIN_WINDOW_ZOOM_LEVEL).toBe(-3);
    expect(MAX_WINDOW_ZOOM_LEVEL).toBe(4);
    expect(ZOOM_LEVEL_STEP).toBe(0.5);
    expect(clampZoomLevel(1.26)).toBe(1.5);
    expect(clampZoomLevel(99)).toBe(4);
    expect(clampZoomLevel(-99)).toBe(-3);
    expect(clampZoomLevel(Number.NaN)).toBe(0);
    expect(Object.is(clampZoomLevel(-0.1), 0)).toBe(true);
    expect(isZoomLevel(0)).toBe(true);
    expect(isZoomLevel(-3)).toBe(true);
    expect(isZoomLevel(4)).toBe(true);
    expect(isZoomLevel(4.5)).toBe(false);
    expect(isZoomLevel(-3.5)).toBe(false);
    expect(isZoomLevel(Number.NaN)).toBe(false);
    expect(isZoomLevel('1')).toBe(false);
    expect(isAspectRatioLockFlag(true)).toBe(true);
    expect(isAspectRatioLockFlag('true')).toBe(false);
    expect(isMinimizeToTrayFlag(false)).toBe(true);
    expect(isMinimizeToTrayFlag(1)).toBe(false);
  });

  it('validates and forwards window:set-aspect-ratio-lock to onSetAspectRatioLock (#332)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    const lockChanges: boolean[] = [];

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      onSetAspectRatioLock: (_win, enabled) => lockChanges.push(enabled),
      log: (line) => logs.push(line),
    });

    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, true)).toBe(true);
    expect(lockChanges).toEqual([true]);

    // Invalid payload is dropped and returns current lock state
    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, 'invalid')).toBe(true);
    expect(logs).toHaveLength(1);
    expect(lockChanges).toEqual([true]);

    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, false)).toBe(false);
    expect(lockChanges).toEqual([true, false]);

    fw.destroy();
    expect(await ipc.invoke(WINDOW_CHANNELS.setAspectRatioLock, fw.sender, true)).toBe(false);

    dispose();
  });

  it('validates and forwards tray and popout IPC channels while dropping malformed payloads (#158)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    let trayEnabled = false;
    const openedPayloads: unknown[] = [];
    const dockedPayloads: unknown[] = [];
    const onClosePopout = vi.fn();

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      getMinimizeToTray: () => trayEnabled,
      onSetMinimizeToTray: (enabled) => {
        trayEnabled = enabled;
        return enabled;
      },
      onOpenPopout: (payload) => {
        openedPayloads.push(payload);
        return true;
      },
      onClosePopout,
      onGetPopoutPayload: (sender) =>
        sender === fw.sender ? { itemKey: 'live:s1:ch1', kind: 'live', title: 'News HD' } : null,
      onDockPopout: (_sender, payload) => {
        dockedPayloads.push(payload);
      },
      log: (line) => logs.push(line),
    });

    // Minimize-to-tray valid & invalid
    expect(await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, true)).toBe(true);
    expect(trayEnabled).toBe(true);
    expect(await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, 'yes')).toBe(true);

    // Popout launch strips credential query params from logo, accepts valid transferEngineId, and rejects raw URL itemKeys or invalid engineIds
    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'News HD',
        logo: 'https://user:secret@cdn.example.test/logo.png?token=abc&size=2x',
        resumePositionMs: 1200,
        transferEngineId: 'engine-4',
      }),
    ).toBe(true);
    expect(openedPayloads).toEqual([
      {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'News HD',
        logo: 'https://cdn.example.test/logo.png?size=2x',
        resumePositionMs: 1200,
        transferEngineId: 'engine-4',
      },
    ]);

    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'Bad transferEngineId',
        transferEngineId: 'x'.repeat(65),
      }),
    ).toBe(false);

    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'http://secret.panel/live/u/p/1.ts',
        kind: 'live',
        title: 'Raw URL forbidden',
      }),
    ).toBe(false);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.openPopout, fw.sender, {
        itemKey: 'live:s1:ch1',
        kind: 'live',
        title: 'Extra key forbidden',
        url: 'http://leak.example/stream.ts',
      }),
    ).toBe(false);

    // Pull payload & dock & close
    expect(await ipc.invoke(WINDOW_CHANNELS.getPopoutPayload, fw.sender)).toEqual({
      itemKey: 'live:s1:ch1',
      kind: 'live',
      title: 'News HD',
    });
    await ipc.invoke(WINDOW_CHANNELS.dockPopout, fw.sender, {
      itemKey: 'movie:s1:m1',
      kind: 'movie',
      title: 'Cinema Film',
      positionMs: 42_500.4,
      transferEngineId: 'engine-4',
    });
    expect(dockedPayloads).toEqual([
      {
        itemKey: 'movie:s1:m1',
        kind: 'movie',
        title: 'Cinema Film',
        positionMs: 42_500,
        transferEngineId: 'engine-4',
      },
    ]);
    await ipc.invoke(WINDOW_CHANNELS.dockPopout, fw.sender, {
      itemKey: 'movie:s1:m1',
      kind: 'movie',
      title: 'Bad transferEngineId',
      transferEngineId: '',
    });
    await ipc.invoke(WINDOW_CHANNELS.dockPopout, fw.sender, {
      itemKey: 'movie:s1:m1',
      kind: 'movie',
      title: 'Negative pos',
      positionMs: -10,
    });
    expect(dockedPayloads).toHaveLength(1);

    await ipc.invoke(WINDOW_CHANNELS.closePopout, fw.sender);
    expect(onClosePopout).toHaveBeenCalledTimes(1);
    expect(logs.length).toBeGreaterThanOrEqual(4);

    dispose();
  });

  it('validates and sanitizes localized tray labels on window:set-minimize-to-tray (LOW #11)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    const received: Array<{ enabled: boolean; labels?: { restore: string; quit: string } }> = [];
    let trayEnabled = false;

    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      getMinimizeToTray: () => trayEnabled,
      onSetMinimizeToTray: (enabled, labels) => {
        trayEnabled = enabled;
        received.push(labels ? { enabled, labels } : { enabled });
        return enabled;
      },
      log: (line) => logs.push(line),
    });

    // Valid localized labels are trimmed and forwarded
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, true, {
        restore: '  ELV IPTV Geri Yükle  ',
        quit: ' Çıkış ',
      }),
    ).toBe(true);
    expect(received).toEqual([
      { enabled: true, labels: { restore: 'ELV IPTV Geri Yükle', quit: 'Çıkış' } },
    ]);

    // Malformed labels (extra keys, control chars, empty, oversized) are dropped cleanly
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: 'Restore',
        quit: 'Quit',
        extra: 'nope',
      }),
    ).toBe(true);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: 'Line\nBreak',
        quit: 'Quit',
      }),
    ).toBe(true);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: '   ',
        quit: 'Quit',
      }),
    ).toBe(true);
    expect(
      await ipc.invoke(WINDOW_CHANNELS.setMinimizeToTray, fw.sender, false, {
        restore: 'a'.repeat(200),
        quit: 'Quit',
      }),
    ).toBe(true);

    expect(received).toHaveLength(1);
    expect(logs).toHaveLength(4);

    dispose();
  });

  it('rejects missing senderFrame, subframes, and untrusted origins across all window IPC channels', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const onOpenExternalUrl = vi.fn(() => true);
    const logs: string[] = [];
    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: () => fw.win,
      onOpenExternalUrl,
      log: (line) => logs.push(line),
    });

    const top = trustedFrame();
    const untrustedEvents = [
      { sender: fw.sender },
      { sender: fw.sender, senderFrame: null },
      { sender: fw.sender, senderFrame: { url: 'app://elv/index.html', top } },
      { sender: fw.sender, senderFrame: trustedFrame('https://evil.example/') },
    ];
    for (const ev of untrustedEvents) {
      await expect(
        ipc.invokeWithEvent(WINDOW_CHANNELS.setAspectRatioLock, ev, true),
      ).rejects.toThrow(/untrusted sender/i);
      await expect(ipc.invokeWithEvent(WINDOW_CHANNELS.getZoomLevel, ev)).rejects.toThrow(
        /untrusted sender/i,
      );
      await expect(
        ipc.invokeWithEvent(
          WINDOW_CHANNELS.openExternalUrl,
          ev,
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ),
      ).rejects.toThrow(/untrusted sender/i);
    }
    expect(onOpenExternalUrl).not.toHaveBeenCalled();
    expect(logs.length).toBe(untrustedEvents.length * 3);
    dispose();
  });

  it('persists, applies, broadcasts, and validates window zoom IPC channels (Wave Q7)', async () => {
    const ipc = fakeIpcMain();
    const fw = fakeWindow();
    const logs: string[] = [];
    let zoom = 0.5;
    const dispose = registerWindowIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: (s) => (s === fw.sender ? fw.win : null),
      getZoomLevel: () => zoom,
      onSetZoomLevel: (next) => {
        zoom = next;
        return zoom;
      },
      log: (line) => logs.push(line),
    });

    expect(await ipc.invoke(WINDOW_CHANNELS.getZoomLevel, fw.sender)).toBe(0.5);

    expect(await ipc.invoke(WINDOW_CHANNELS.setZoomLevel, fw.sender, 1.3)).toBe(1.5);
    expect(zoom).toBe(1.5);
    expect(fw.setCalls).toContainEqual(['setZoomLevel', 1.5]);
    expect(fw.sent).toEqual([{ channel: WINDOW_CHANNELS.zoomLevelChanged, args: [1.5] }]);

    // Clamps out-of-range finite values cleanly
    expect(await ipc.invoke(WINDOW_CHANNELS.setZoomLevel, fw.sender, 10)).toBe(4);
    expect(await ipc.invoke(WINDOW_CHANNELS.setZoomLevel, fw.sender, -10)).toBe(-3);

    // Drops non-finite / non-number payloads and logs
    expect(await ipc.invoke(WINDOW_CHANNELS.setZoomLevel, fw.sender, 'big')).toBe(-3);
    expect(await ipc.invoke(WINDOW_CHANNELS.setZoomLevel, fw.sender, Number.NaN)).toBe(-3);
    expect(logs).toHaveLength(2);

    // Rejects untrusted sender frames
    await expect(
      ipc.invokeWithEvent(WINDOW_CHANNELS.getZoomLevel, {
        sender: fw.sender,
        senderFrame: trustedFrame('https://evil.example/'),
      }),
    ).rejects.toThrow(/untrusted sender/i);
    await expect(
      ipc.invokeWithEvent(
        WINDOW_CHANNELS.setZoomLevel,
        { sender: fw.sender, senderFrame: trustedFrame('https://evil.example/') },
        1,
      ),
    ).rejects.toThrow(/untrusted sender/i);

    dispose();
    expect(ipc.handlers.size).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DIAGNOSTIC_REPORT_FILENAME,
  DIAGNOSTICS_CHANNELS,
  MAX_DIAGNOSTIC_LOG_LINES,
  MAX_DIAGNOSTIC_REPORT_BYTES,
} from '../shared/diagnostics-ipc.ts';
import { registerDiagnosticsIpc } from './diagnostics-ipc.ts';

function trustedFrame(url = 'app://elv/index.html') {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = frame;
  return frame;
}

function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(ch, fn);
      }),
      removeHandler: vi.fn((ch: string) => {
        handlers.delete(ch);
      }),
    },
    invoke: (ch: string, sender: unknown, ...args: unknown[]) => {
      const fn = handlers.get(ch);
      if (!fn) throw new Error(`missing handler ${ch}`);
      return Promise.resolve(fn({ sender, senderFrame: trustedFrame() }, ...args));
    },
    invokeRaw: (ch: string, event: unknown, ...args: unknown[]) => {
      const fn = handlers.get(ch);
      if (!fn) throw new Error(`missing handler ${ch}`);
      return Promise.resolve(fn(event, ...args));
    },
  };
}

describe('registerDiagnosticsIpc (#226)', () => {
  it('registers exact diagnostic channels, clamps readLogTail to 1..250, re-redacts output, and disposes cleanly', async () => {
    expect(DIAGNOSTICS_CHANNELS).toEqual({
      readLogTail: 'diagnostics:readLogTail',
      exportReport: 'diagnostics:exportReport',
      copyText: 'diagnostics:copyText',
    });

    const ipc = fakeIpcMain();
    const readLogTail = vi.fn(async (maxLines: number) => [
      `limit=${maxLines} C:\\Users\\Alice\\file.log https://u:p@host.test/a/b.ts?token=xyz`,
    ]);
    const dispose = registerDiagnosticsIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: () => null,
      readLogTail,
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      writeFile: vi.fn(async () => undefined),
      writeClipboardText: vi.fn(),
    });

    // Default undefined -> 250
    const defLines = (await ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, {})) as string[];
    expect(readLogTail).toHaveBeenLastCalledWith(MAX_DIAGNOSTIC_LOG_LINES);
    expect(defLines[0]).toContain('<redacted-path>');
    expect(defLines[0]).not.toContain('Alice');
    expect(defLines[0]).not.toContain('u:p');
    expect(defLines[0]).not.toContain('token=xyz');

    // Clamp > 250 to 250 and < 1 to 1
    await ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, {}, 999);
    expect(readLogTail).toHaveBeenLastCalledWith(250);
    await ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, {}, 0);
    expect(readLogTail).toHaveBeenLastCalledWith(1);
    await ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, {}, -5);
    expect(readLogTail).toHaveBeenLastCalledWith(1);
    await ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, {}, 42.9);
    expect(readLogTail).toHaveBeenLastCalledWith(42);

    // Reject invalid non-numeric inputs strictly
    for (const bad of ['50', null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      await expect(ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, {}, bad)).rejects.toThrow();
    }

    dispose();
    expect(ipc.ipcMain.removeHandler).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.readLogTail);
    expect(ipc.ipcMain.removeHandler).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.exportReport);
    expect(ipc.ipcMain.removeHandler).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.copyText);
  });

  it('exports re-redacted Markdown strictly via showSaveDialog user-chosen path and never accepts renderer file paths', async () => {
    const ipc = fakeIpcMain();
    const fakeWin = { id: 'win-1' };
    const written: Array<{ path: string; content: string }> = [];
    const showSaveDialog = vi.fn<() => Promise<{ canceled: boolean; filePath?: string }>>(
      async () => ({
        canceled: false,
        filePath: 'C:\\chosen\\elv-iptv-diagnostic-report.md',
      }),
    );
    const writeFile = vi.fn(async (filePath: string, content: string) => {
      written.push({ path: filePath, content });
    });
    const log = vi.fn();

    registerDiagnosticsIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: () => fakeWin,
      readLogTail: async () => [],
      showSaveDialog,
      writeFile,
      writeClipboardText: vi.fn(),
      log,
    });

    const rawMarkdown =
      '# ELV IPTV Diagnostic Report\nPath: /Users/bob/secret.log\nURL: https://user:pw@cdn.example.test/live/u/p/1.m3u8?api_key=k\n';
    const reply = await ipc.invoke(
      DIAGNOSTICS_CHANNELS.exportReport,
      {},
      { markdown: rawMarkdown },
    );

    expect(reply).toEqual({ saved: true });
    expect(showSaveDialog).toHaveBeenCalledWith(fakeWin, {
      defaultPath: DEFAULT_DIAGNOSTIC_REPORT_FILENAME,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe('C:\\chosen\\elv-iptv-diagnostic-report.md');
    expect(written[0]?.content).toContain('<redacted-path>');
    expect(written[0]?.content).not.toContain('bob');
    expect(written[0]?.content).not.toContain('user:pw');
    expect(written[0]?.content).not.toContain('api_key=k');

    // Cancelled save dialog returns { saved: false } and writes nothing
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    expect(
      await ipc.invoke(DIAGNOSTICS_CHANNELS.exportReport, {}, { markdown: '# Report' }),
    ).toEqual({ saved: false });
    expect(written).toHaveLength(1);

    // Rejects renderer-supplied file paths, extra keys, prototype pollution, empty, and > 512 KiB payloads
    const polluted = JSON.parse('{"markdown":"# ok","__proto__":{"x":1}}');
    const oversized = 'a'.repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1);
    for (const bad of [
      null,
      '# raw string',
      {},
      { markdown: '' },
      { markdown: '   ' },
      { markdown: 123 },
      { markdown: '# ok', filePath: '/etc/passwd' },
      { markdown: '# ok', path: 'C:\\evil.md' },
      { markdown: oversized },
      polluted,
    ]) {
      await expect(ipc.invoke(DIAGNOSTICS_CHANNELS.exportReport, {}, bad)).rejects.toThrow();
    }
    expect(written).toHaveLength(1);
    // Log notices never echo sensitive markdown payload
    expect(log.mock.calls.flat().join('\n')).not.toContain('/etc/passwd');
  });

  it('copies re-redacted text bounded to <= 512 KiB via diagnostics:copyText and rejects invalid inputs', async () => {
    const ipc = fakeIpcMain();
    const copied: string[] = [];

    registerDiagnosticsIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: () => null,
      readLogTail: async () => [],
      showSaveDialog: async () => ({ canceled: true }),
      writeFile: async () => undefined,
      writeClipboardText: (text) => {
        copied.push(text);
      },
    });

    const ok = await ipc.invoke(
      DIAGNOSTICS_CHANNELS.copyText,
      {},
      { text: 'Crash in /home/dan/app Authorization: Bearer tok123' },
    );
    expect(ok).toBe(true);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('<redacted-path>');
    expect(copied[0]).not.toContain('dan');
    expect(copied[0]).not.toContain('tok123');

    const polluted = JSON.parse('{"text":"ok","__proto__":{"x":1}}');
    const oversized = 'x'.repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1);
    for (const bad of [
      null,
      'plain',
      {},
      { text: '' },
      { text: '   ' },
      { text: 42 },
      { text: 'ok', extra: 1 },
      { text: oversized },
      polluted,
    ]) {
      await expect(ipc.invoke(DIAGNOSTICS_CHANNELS.copyText, {}, bad)).rejects.toThrow();
    }
    expect(copied).toHaveLength(1);
  });

  it('rejects untrusted origins, missing senderFrame, and subframes on all diagnostics channels', async () => {
    const ipc = fakeIpcMain();
    const readLogTail = vi.fn(async () => ['line']);
    const writeClipboardText = vi.fn();
    const log = vi.fn();

    const dispose = registerDiagnosticsIpc({
      ipcMain: ipc.ipcMain,
      getWindowFromSender: () => null,
      readLogTail,
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      writeFile: vi.fn(async () => undefined),
      writeClipboardText,
      log,
    });

    const top = trustedFrame();
    const badEvents = [
      { sender: {} },
      { sender: {}, senderFrame: null },
      { sender: {}, senderFrame: { url: 'app://elv/index.html', top } },
      { sender: {}, senderFrame: trustedFrame('https://evil.example/') },
    ];
    for (const ev of badEvents) {
      await expect(ipc.invokeRaw(DIAGNOSTICS_CHANNELS.readLogTail, ev, 10)).rejects.toThrow(
        /untrusted sender/i,
      );
      await expect(
        ipc.invokeRaw(DIAGNOSTICS_CHANNELS.exportReport, ev, { markdown: '# ok' }),
      ).rejects.toThrow(/untrusted sender/i);
      await expect(
        ipc.invokeRaw(DIAGNOSTICS_CHANNELS.copyText, ev, { text: 'ok' }),
      ).rejects.toThrow(/untrusted sender/i);
    }
    expect(readLogTail).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(badEvents.length * 3);
    dispose();
  });
});

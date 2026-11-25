import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticsBridge } from '../../src/shared/diagnostics-ipc.ts';
import { createDesktopDiagnosticsPort } from './diagnostics-port.ts';

describe('createDesktopDiagnosticsPort (#226)', () => {
  it('delegates readLogTail, copyText, and exportMarkdown to window.elv.diagnostics and redacts recorded logs', async () => {
    const bridge: DiagnosticsBridge = {
      readLogTail: vi.fn(async () => ['main-1', 'main-2']),
      exportReport: vi.fn(async () => ({ saved: true })),
      copyReport: vi.fn(async () => true),
    };

    const port = createDesktopDiagnosticsPort(bridge, {
      appVersion: '1.2.3',
      platformLabel: 'Desktop (Windows)',
    });

    expect(port.appVersion).toBe('1.2.3');
    expect(port.platformLabel).toBe('Desktop (Windows)');

    port.recordDiagnosticLog?.('renderer failed https://u:p@cdn.example.test/live/u/p/1.ts');
    const tail = await port.readLogTail(50);
    expect(bridge.readLogTail).toHaveBeenCalledWith(50);
    expect(tail.slice(0, 2)).toEqual(['main-1', 'main-2']);
    expect(tail[2]).toContain('https://cdn.example.test/***/***/***/***.ts');
    expect(tail[2]).not.toContain('u:p');

    expect(await port.copyText?.('# Report')).toBe(true);
    expect(bridge.copyReport).toHaveBeenCalledWith('# Report');

    expect(await port.exportMarkdown?.('# Report')).toBe(true);
    expect(bridge.exportReport).toHaveBeenCalledWith('# Report');
  });

  it('degrades gracefully without Electron preload bridge', async () => {
    const port = createDesktopDiagnosticsPort(undefined);
    port.recordDiagnosticLog?.('local error C:\\Users\\Alice\\file.ts');

    const tail = await port.readLogTail(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toContain('<redacted-path>');
    expect(tail[0]).not.toContain('Alice');
    expect(await port.exportMarkdown?.('# Report')).toBe(false);
  });
});

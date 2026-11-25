import { describe, expect, it, vi } from 'vitest';
import { DIAGNOSTICS_CHANNELS, MAX_DIAGNOSTIC_REPORT_BYTES } from '../shared/diagnostics-ipc.ts';
import { createDiagnosticsBridge } from './diagnostics-bridge.ts';

describe('createDiagnosticsBridge (#226)', () => {
  it('returns a frozen bridge forwarding readLogTail, exportReport, and copyReport over exact channels', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === DIAGNOSTICS_CHANNELS.readLogTail) return ['line-1', 'line-2'];
      if (channel === DIAGNOSTICS_CHANNELS.exportReport) return { saved: true };
      if (channel === DIAGNOSTICS_CHANNELS.copyText) return true;
      return null;
    });
    const bridge = createDiagnosticsBridge({ invoke });
    expect(Object.isFrozen(bridge)).toBe(true);

    expect(await bridge.readLogTail()).toEqual(['line-1', 'line-2']);
    expect(invoke).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.readLogTail, 250);

    expect(await bridge.readLogTail(500)).toEqual(['line-1', 'line-2']);
    expect(invoke).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.readLogTail, 250);

    expect(await bridge.exportReport('# ELV IPTV Diagnostic Report')).toEqual({ saved: true });
    expect(invoke).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.exportReport, {
      markdown: '# ELV IPTV Diagnostic Report',
    });

    expect(await bridge.copyReport('# ELV IPTV Diagnostic Report')).toBe(true);
    expect(invoke).toHaveBeenCalledWith(DIAGNOSTICS_CHANNELS.copyText, {
      text: '# ELV IPTV Diagnostic Report',
    });
  });

  it('rejects invalid inputs before invoking IPC and rejects malformed main replies', async () => {
    const invoke = vi.fn(async () => 'unexpected');
    const bridge = createDiagnosticsBridge({ invoke });

    await expect(bridge.readLogTail(Number.NaN)).rejects.toThrow();
    await expect(bridge.readLogTail('10' as unknown as number)).rejects.toThrow();
    await expect(bridge.exportReport('')).rejects.toThrow();
    await expect(bridge.exportReport(' '.repeat(4))).rejects.toThrow();
    await expect(
      bridge.exportReport('a'.repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1)),
    ).rejects.toThrow();
    await expect(bridge.copyReport('')).rejects.toThrow();
    await expect(bridge.copyReport('x'.repeat(MAX_DIAGNOSTIC_REPORT_BYTES + 1))).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();

    // Unexpected replies from main are rejected
    await expect(bridge.readLogTail(10)).rejects.toThrow(/unexpected/i);
    await expect(bridge.exportReport('# Valid')).rejects.toThrow(/unexpected/i);
    await expect(bridge.copyReport('# Valid')).rejects.toThrow(/unexpected/i);
  });
});

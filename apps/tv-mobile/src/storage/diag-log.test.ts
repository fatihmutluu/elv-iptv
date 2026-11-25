import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: '1.2.3' } },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', isTV: false, Version: 34 },
  Share: { share: vi.fn(async () => ({ action: 'sharedAction' })) },
}));

import { createMobileDiagnosticsPort } from './diag-log';

describe('createMobileDiagnosticsPort (#226)', () => {
  it('stores redacted log lines up to 250 entries and redacts exported Markdown', async () => {
    const shareFn = vi.fn<(content: { message: string }) => Promise<void>>(async () => undefined);
    const port = createMobileDiagnosticsPort({
      appVersion: '1.2.3',
      os: 'android',
      isTV: true,
      osVersion: '34',
      shareFn,
    });

    expect(port.appVersion).toBe('1.2.3');
    expect(port.platformLabel).toBe('Android TV');
    expect(port.osVersion).toBe('34');

    port.recordDiagnosticLog?.('Failed opening https://user:secretpass@iptv.example.test/live.ts');
    const tail = await port.readLogTail(10);
    expect(tail).toHaveLength(1);
    expect(tail[0]).not.toContain('secretpass');

    const exported = await port.exportMarkdown?.(
      '# Report\nPath: /Users/alice/playlists/my.m3u\nUrl: https://u:p@host.test/a',
    );
    expect(exported).toBe(true);
    expect(shareFn).toHaveBeenCalledTimes(1);
    const sharedMsg = shareFn.mock.calls[0]?.[0]?.message ?? '';
    expect(sharedMsg).not.toContain('alice');
    expect(sharedMsg).not.toContain('u:p@');
  });

  it('returns false cleanly when Share.share throws', async () => {
    const port = createMobileDiagnosticsPort({
      shareFn: async () => {
        throw new Error('cancelled');
      },
    });
    await expect(port.exportMarkdown?.('# Report')).resolves.toBe(false);
  });

  it('omits exportMarkdown on tvOS where UIActivityViewController is unavailable', () => {
    const port = createMobileDiagnosticsPort({ os: 'ios', isTV: true });
    expect(port.platformLabel).toBe('tvOS');
    expect(port.exportMarkdown).toBeUndefined();
  });
});

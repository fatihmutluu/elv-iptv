import { describe, expect, it } from 'vitest';
import {
  type DesktopUpdateState,
  isAllowedReleasePageUrl,
  isDesktopUpdateState,
  isDesktopUpdateStatus,
  isUpdaterBridge,
  UPDATER_CHANNELS,
} from './updater-ipc.ts';

describe('updater-ipc shared contract & guards', () => {
  it('freezes canonical UPDATER_CHANNELS', () => {
    expect(Object.isFrozen(UPDATER_CHANNELS)).toBe(true);
    expect(UPDATER_CHANNELS).toEqual({
      getState: 'updater:get-state',
      check: 'updater:check',
      download: 'updater:download',
      install: 'updater:install',
      openReleasePage: 'updater:open-release-page',
      stateChanged: 'updater:state-changed',
    });
  });

  it('validates DesktopUpdateStatus exhaustively', () => {
    const valid = [
      'unsupported',
      'idle',
      'checking',
      'available',
      'up-to-date',
      'downloading',
      'downloaded',
      'error',
    ];
    for (const status of valid) {
      expect(isDesktopUpdateStatus(status)).toBe(true);
    }
    expect(isDesktopUpdateStatus('ready')).toBe(false);
    expect(isDesktopUpdateStatus('')).toBe(false);
    expect(isDesktopUpdateStatus(null)).toBe(false);
  });

  it('enforces strict HTTPS GitHub releases allowlist for manualDownloadUrl', () => {
    expect(
      isAllowedReleasePageUrl('https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0'),
    ).toBe(true);
    expect(isAllowedReleasePageUrl('https://github.com/fatihmutluu/elv-iptv/releases/latest')).toBe(
      true,
    );
    expect(isAllowedReleasePageUrl('https://github.com/fatihmutluu/elv-iptv/releases')).toBe(true);

    // Reject HTTP, wrong host, wrong repo, credentials, ports, traversal, control chars
    expect(
      isAllowedReleasePageUrl('http://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0'),
    ).toBe(false);
    expect(
      isAllowedReleasePageUrl('https://evil.example/fatihmutluu/elv-iptv/releases/tag/v1.2.0'),
    ).toBe(false);
    expect(isAllowedReleasePageUrl('https://github.com/other-org/elv-iptv/releases/latest')).toBe(
      false,
    );
    expect(
      isAllowedReleasePageUrl('https://user:pass@github.com/fatihmutluu/elv-iptv/releases/latest'),
    ).toBe(false);
    expect(
      isAllowedReleasePageUrl('https://github.com:8443/fatihmutluu/elv-iptv/releases/latest'),
    ).toBe(false);
    expect(
      isAllowedReleasePageUrl('https://github.com/fatihmutluu/elv-iptv/releases/../../evil'),
    ).toBe(false);
    expect(
      isAllowedReleasePageUrl('https://github.com/fatihmutluu/elv-iptv/releases/%2e%2e/evil'),
    ).toBe(false);
    expect(
      isAllowedReleasePageUrl('https://github.com/fatihmutluu/elv-iptv/releases/tag/v1\nHeader:x'),
    ).toBe(false);
    expect(isAllowedReleasePageUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedReleasePageUrl('')).toBe(false);
    expect(isAllowedReleasePageUrl(123)).toBe(false);
  });

  it('validates well-formed DesktopUpdateState and rejects malformed or unsafe payloads', () => {
    const validState: DesktopUpdateState = {
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      releaseNotes: '- Faster startup\n- Bug fixes',
      manualDownloadUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.1.0',
      downloadPercent: 0,
      checkedAt: '2026-11-28T00:00:00.000Z',
    };
    expect(isDesktopUpdateState(validState)).toBe(true);
    expect(isDesktopUpdateState({ status: 'unsupported', currentVersion: '1.0.0' })).toBe(true);
    expect(
      isDesktopUpdateState({
        status: 'downloading',
        currentVersion: '1.0.0',
        availableVersion: '1.1.0',
        downloadPercent: 42.5,
      }),
    ).toBe(true);
    expect(
      isDesktopUpdateState({
        status: 'error',
        currentVersion: '1.0.0',
        errorCode: 'network_error',
      }),
    ).toBe(true);

    // Malformed payloads
    expect(isDesktopUpdateState(null)).toBe(false);
    expect(isDesktopUpdateState([])).toBe(false);
    expect(isDesktopUpdateState({ status: 'idle', currentVersion: '' })).toBe(false);
    expect(isDesktopUpdateState({ status: 'idle', currentVersion: '1.0.0\u0000' })).toBe(false);
    expect(
      isDesktopUpdateState({
        status: 'available',
        currentVersion: '1.0.0',
        manualDownloadUrl: 'https://example.invalid/download.exe',
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateState({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadPercent: 101,
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateState({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadPercent: Number.NaN,
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateState({
        status: 'available',
        currentVersion: '1.0.0',
        releaseNotes: 'ok\u0007bell',
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateState({
        status: 'idle',
        currentVersion: '1.0.0',
        extraField: true,
      }),
    ).toBe(false);
    const polluted = JSON.parse('{"status":"idle","currentVersion":"1.0.0","__proto__":{}}');
    expect(isDesktopUpdateState(polluted)).toBe(false);
  });

  it('validates UpdaterBridge shape via isUpdaterBridge', () => {
    const noop = async () => ({ status: 'idle' as const, currentVersion: '1.0.0' });
    const bridge = {
      getState: noop,
      checkForUpdates: noop,
      downloadUpdate: noop,
      installUpdate: async () => undefined,
      openReleasePage: async () => true,
      onStateChanged: () => () => undefined,
    };
    expect(isUpdaterBridge(bridge)).toBe(true);
    expect(isUpdaterBridge({ ...bridge, installUpdate: 'nope' })).toBe(false);
    expect(isUpdaterBridge(null)).toBe(false);
    expect(isUpdaterBridge(undefined)).toBe(false);
  });
});

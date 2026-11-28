import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateState } from '../../shared/updater-ipc.ts';
import {
  createDesktopUpdaterService,
  createGitHubReleasesCheckProvider,
  detectUpdaterSupport,
  parseSha256Sums,
  verifySha256Digest,
} from './desktop-updater.ts';

describe('detectUpdaterSupport', () => {
  it('disables updater completely on Microsoft Store (MSIX) and Mac App Store builds', () => {
    expect(detectUpdaterSupport({ platform: 'win32', isPackaged: true, windowsStore: true })).toBe(
      'unsupported',
    );
    expect(detectUpdaterSupport({ platform: 'darwin', isPackaged: true, mas: true })).toBe(
      'unsupported',
    );
  });

  it('uses manual-linux on Linux without APPIMAGE and direct on AppImage/Windows/macOS', () => {
    expect(detectUpdaterSupport({ platform: 'linux', isPackaged: true })).toBe('manual-linux');
    expect(detectUpdaterSupport({ platform: 'linux', isPackaged: true, appImage: '' })).toBe(
      'manual-linux',
    );
    expect(
      detectUpdaterSupport({
        platform: 'linux',
        isPackaged: true,
        appImage: '/opt/elv-iptv.AppImage',
      }),
    ).toBe('direct');
    expect(detectUpdaterSupport({ platform: 'win32', isPackaged: true })).toBe('direct');
    expect(detectUpdaterSupport({ platform: 'darwin', isPackaged: true })).toBe('direct');
  });
});

describe('createDesktopUpdaterService', () => {
  it('stays completely inactive with zero network or shutdown calls on Store builds', async () => {
    const checkProvider = vi.fn();
    const downloadAndVerify = vi.fn();
    const beforeShutdown = vi.fn();
    const shutdownCatalog = vi.fn();
    const quitAndInstall = vi.fn();

    const service = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true, windowsStore: true },
      checkProvider,
      downloadAndVerify,
      beforeShutdown,
      shutdownCatalog,
      quitAndInstall,
    });

    expect(service.support).toBe('unsupported');
    expect(service.getState()).toEqual({ status: 'unsupported', currentVersion: '1.0.0' });
    expect(await service.checkForUpdates()).toEqual({
      status: 'unsupported',
      currentVersion: '1.0.0',
    });
    expect(await service.downloadUpdate()).toEqual({
      status: 'unsupported',
      currentVersion: '1.0.0',
    });
    await service.installUpdate();
    expect(service.getManualDownloadUrl()).toBeNull();

    expect(checkProvider).not.toHaveBeenCalled();
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(beforeShutdown).not.toHaveBeenCalled();
    expect(shutdownCatalog).not.toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('checks explicitly without auto-downloading, streams download progress, verifies SHA-256, and flushes before quitAndInstall', async () => {
    const payload = Buffer.from('signed-installer-payload');
    const expectedSha256 = createHash('sha256').update(payload).digest('hex');
    const order: string[] = [];
    const states: DesktopUpdateState[] = [];

    const checkProvider = vi.fn(async () => ({
      version: '1.2.0',
      releaseNotes: '<script>evil()</script>## Fixes\n- Smooth 60fps playback',
      releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
      assetUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/download/v1.2.0/elv-setup.exe',
      expectedSha256,
    }));

    const downloadAndVerify = vi.fn(async (ctx) => {
      ctx.onProgress(25);
      ctx.onProgress(80);
      return { verified: true as const, actualSha256: expectedSha256 };
    });

    const beforeShutdown = vi.fn(async () => {
      order.push('beforeShutdown');
    });
    const shutdownCatalog = vi.fn(async () => {
      order.push('shutdownCatalog');
    });
    const quitAndInstall = vi.fn(async () => {
      order.push('quitAndInstall');
    });

    const service = createDesktopUpdaterService({
      currentVersion: '1.1.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider,
      downloadAndVerify,
      beforeShutdown,
      shutdownCatalog,
      quitAndInstall,
      now: () => '2026-11-28T03:00:00.000Z',
    });

    const unsub = service.subscribe((s) => states.push(s));

    // Zero network requests on construction
    expect(checkProvider).not.toHaveBeenCalled();
    expect(service.getState().status).toBe('idle');

    // Explicit user check -> available (no auto-download!)
    const checked = await service.checkForUpdates();
    expect(checked.status).toBe('available');
    expect(checked.availableVersion).toBe('1.2.0');
    expect(checked.releaseNotes).toContain('Smooth 60fps playback');
    expect(checked.releaseNotes).not.toContain('<script>');
    expect(checked.manualDownloadUrl).toBeUndefined();
    expect(service.getManualDownloadUrl()).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
    );
    expect(downloadAndVerify).not.toHaveBeenCalled();

    // installUpdate is ignored before downloaded
    await service.installUpdate();
    expect(quitAndInstall).not.toHaveBeenCalled();

    // Explicit user download
    const downloaded = await service.downloadUpdate();
    expect(downloaded.status).toBe('downloaded');
    expect(downloaded.downloadPercent).toBe(100);
    expect(states.some((s) => s.status === 'downloading' && s.downloadPercent === 25)).toBe(true);
    expect(states.some((s) => s.status === 'downloading' && s.downloadPercent === 80)).toBe(true);

    // Concurrent installUpdate calls run shutdown sequence strictly once in exact order
    await Promise.all([service.installUpdate(), service.installUpdate()]);
    expect(order).toEqual(['beforeShutdown', 'shutdownCatalog', 'quitAndInstall']);
    expect(beforeShutdown).toHaveBeenCalledTimes(1);
    expect(shutdownCatalog).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);

    unsub();
  });

  it('rejects checksum mismatches and exposes manualDownloadUrl instead of installing unverified binaries', async () => {
    const service = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'darwin', isPackaged: true },
      checkProvider: async () => ({
        version: '1.1.0',
        releaseNotes: 'Security fix',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.1.0',
        assetUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/download/v1.1.0/elv.dmg',
        expectedSha256: 'a'.repeat(64),
      }),
      downloadAndVerify: async () => ({
        verified: true,
        actualSha256: 'b'.repeat(64),
      }),
      quitAndInstall: vi.fn(),
    });

    await service.checkForUpdates();
    const afterDownload = await service.downloadUpdate();
    expect(afterDownload.status).toBe('error');
    expect(afterDownload.errorCode).toBe('checksum_mismatch');
    expect(afterDownload.manualDownloadUrl).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.1.0',
    );
  });

  it('exposes manualDownloadUrl on manual-linux or when no direct verified asset/driver exists', async () => {
    const manualLinux = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'linux', isPackaged: true },
      checkProvider: async () => ({
        version: '1.2.0',
        releaseNotes: 'Linux release',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
      }),
    });

    const state = await manualLinux.checkForUpdates();
    expect(state.status).toBe('available');
    expect(state.manualDownloadUrl).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
    );
    // downloadUpdate is a safe no-op on manual-linux
    expect((await manualLinux.downloadUpdate()).status).toBe('available');

    // Direct platform without verified checksum falls back to manualDownloadUrl
    const noChecksumDirect = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => ({
        version: '1.2.0',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
      }),
    });
    const fallbackState = await noChecksumDirect.checkForUpdates();
    expect(fallbackState.status).toBe('available');
    expect(fallbackState.manualDownloadUrl).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
    );
  });

  it('reports up-to-date when latest version is equal, older, or a prerelease for stable installs', async () => {
    const service = createDesktopUpdaterService({
      currentVersion: '1.2.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => ({
        version: '1.3.0-beta.1',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.3.0-beta.1',
      }),
    });
    const state = await service.checkForUpdates();
    expect(state.status).toBe('up-to-date');
    expect(state.availableVersion).toBeUndefined();
  });
});

describe('createGitHubReleasesCheckProvider and SHA256SUMS helpers', () => {
  it('parses SHA256SUMS lines and verifies digests safely', () => {
    const hash = createHash('sha256').update('hello-elv').digest('hex');
    const sums = parseSha256Sums(`${hash}  elv-iptv-1.2.0.AppImage\n# comment\ninvalid line\n`);
    expect(sums.get('elv-iptv-1.2.0.AppImage')).toBe(hash);
    expect(verifySha256Digest(Buffer.from('hello-elv'), hash)).toBe(true);
    expect(verifySha256Digest(Buffer.from('tampered'), hash)).toBe(false);
    expect(verifySha256Digest(Buffer.from('hello-elv'), 'not-hex')).toBe(false);
  });

  it('validates GitHub Releases JSON, enforces response size cap, and rejects disallowed URLs', async () => {
    const okFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v1.4.0',
            body: 'New features',
            html_url: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.4.0',
            draft: false,
            prerelease: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = createGitHubReleasesCheckProvider({ fetch: okFetch });
    const result = await provider();
    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.4.0');
    expect(result?.releasePageUrl).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.4.0',
    );

    // Reject oversized response (> 512 KiB)
    const hugeFetch = vi.fn(
      async () =>
        new Response('x'.repeat(513 * 1024), {
          status: 200,
          headers: { 'content-length': String(513 * 1024) },
        }),
    );
    await expect(createGitHubReleasesCheckProvider({ fetch: hugeFetch })()).rejects.toThrow(
      /size/i,
    );

    // Reject untrusted html_url
    const evilFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v1.4.0',
            html_url: 'https://evil.example/releases/v1.4.0',
            draft: false,
          }),
          { status: 200 },
        ),
    );
    await expect(createGitHubReleasesCheckProvider({ fetch: evilFetch })()).rejects.toThrow(/url/i);

    // Draft releases return null; non-2xx responses throw http_<status>
    const draftFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ tag_name: 'v1.5.0', draft: true }), { status: 200 }),
    );
    expect(await createGitHubReleasesCheckProvider({ fetch: draftFetch })()).toBeNull();

    const errFetch = vi.fn(async () => new Response('rate limited', { status: 403 }));
    await expect(createGitHubReleasesCheckProvider({ fetch: errFetch })()).rejects.toThrow(
      /http_403/,
    );
  });

  it('handles check/download errors, fallbackToManual, and still runs shutdownCatalog if beforeShutdown rejects', async () => {
    const order: string[] = [];
    const failingCheck = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => {
        throw new Error('http_503');
      },
    });
    const failedState = await failingCheck.checkForUpdates();
    expect(failedState.status).toBe('error');
    expect(failedState.errorCode).toBe('http_503');

    const fallbackService = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => ({
        version: '1.2.0',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
        expectedSha256: 'a'.repeat(64),
      }),
      downloadAndVerify: async () => ({ verified: false, fallbackToManual: true }),
    });
    await fallbackService.checkForUpdates();
    const afterFallback = await fallbackService.downloadUpdate();
    expect(afterFallback.status).toBe('available');
    expect(afterFallback.manualDownloadUrl).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
    );

    const payload = Buffer.from('verified-bytes');
    const hash = createHash('sha256').update(payload).digest('hex');
    const resilientInstall = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => ({
        version: '1.3.0',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.3.0',
        expectedSha256: hash,
      }),
      downloadAndVerify: async () => ({ verified: true, bytes: payload }),
      beforeShutdown: async () => {
        order.push('beforeShutdown');
        throw new Error('sync flush timed out');
      },
      shutdownCatalog: async () => {
        order.push('shutdownCatalog');
      },
      quitAndInstall: async () => {
        order.push('quitAndInstall');
      },
    });
    await resilientInstall.checkForUpdates();
    expect((await resilientInstall.downloadUpdate()).status).toBe('downloaded');
    await resilientInstall.installUpdate();
    expect(order).toEqual(['beforeShutdown', 'shutdownCatalog', 'quitAndInstall']);
  });

  it('aborts cleanly when response body stalls past timeoutMs instead of hanging forever', async () => {
    const stalledFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"tag_name":'));
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const provider = createGitHubReleasesCheckProvider({
      fetch: stalledFetch as unknown as typeof globalThis.fetch,
      timeoutMs: 40,
    });
    await expect(provider()).rejects.toThrow(/abort|timeout/i);
  });

  it('clears inFlightInstall in finally on quitAndInstall failure/return, clears stale release on failed re-check, narrows error classification, and gates unpackaged Linux/desktop', async () => {
    // Unpackaged Linux with APPIMAGE stays manual-linux
    expect(
      detectUpdaterSupport({
        platform: 'linux',
        isPackaged: false,
        appImage: '/tmp/dev.AppImage',
      }),
    ).toBe('manual-linux');

    // Generic fetch TypeError mentioning "URL" is classified as check_failed (not invalid_release_url)
    const genericErrService = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => {
        throw new TypeError('Failed to parse URL from network proxy');
      },
    });
    expect((await genericErrService.checkForUpdates()).errorCode).toBe('check_failed');

    // Stale latestReleasePageUrl is cleared when a subsequent check fails
    let shouldFail = false;
    const staleCheckService = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => {
        if (shouldFail) throw new Error('http_500');
        return {
          version: '1.2.0',
          releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
        };
      },
    });
    await staleCheckService.checkForUpdates();
    expect(staleCheckService.getManualDownloadUrl()).toBe(
      'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
    );
    shouldFail = true;
    expect((await staleCheckService.checkForUpdates()).status).toBe('error');
    expect(staleCheckService.getManualDownloadUrl()).toBeNull();

    // installUpdate() clears inFlightInstall in finally if quitAndInstall rejects or returns without exiting
    const payload = Buffer.from('installer-bin');
    const hash = createHash('sha256').update(payload).digest('hex');
    let quitAttempts = 0;
    const deadlockCheckService = createDesktopUpdaterService({
      currentVersion: '1.0.0',
      env: { platform: 'win32', isPackaged: true },
      checkProvider: async () => ({
        version: '1.4.0',
        releasePageUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.4.0',
        expectedSha256: hash,
      }),
      downloadAndVerify: async () => ({ verified: true, bytes: payload }),
      quitAndInstall: async () => {
        quitAttempts++;
        if (quitAttempts === 1) throw new Error('installer locked');
      },
    });
    await deadlockCheckService.checkForUpdates();
    await deadlockCheckService.downloadUpdate();
    await expect(deadlockCheckService.installUpdate()).rejects.toThrow('installer locked');
    // Subsequent retry succeeds instead of returning the rejected promise or deadlocking
    await expect(deadlockCheckService.installUpdate()).resolves.toBeUndefined();
    expect(quitAttempts).toBe(2);
    // Subsequent checkForUpdates also works (not blocked by stale inFlightInstall)
    expect((await deadlockCheckService.checkForUpdates()).status).toBe('available');
  });
});

import type { SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  buildMultiViewTileInput,
  computeMultiViewGridLayout,
  formatMultiViewBannerText,
  mapAddFailureToBanner,
  mapPlaybackStatusToTileStatus,
  moveMultiViewGridFocus,
  resolveMultiViewCapabilities,
} from './multiview-model';
import { routeSettingsMenuKey } from './settings-menu-nav';
import { resolvePipAspectRatio } from './usePlayerPip';

const SAMPLE_SOURCES: readonly SourceRow[] = [
  {
    id: 'src-1',
    kind: 'xtream',
    name: 'Primary TV',
    needsImport: false,
    accountMeta: { maxConnections: 1, activeConnections: 0 },
  } as unknown as SourceRow,
  {
    id: 'src-2',
    kind: 'm3u',
    name: 'Secondary Feed',
    needsImport: false,
  } as unknown as SourceRow,
];

describe('Wave F6 pure models (PiP, Multi-View, Settings nav)', () => {
  it('resolves PiP aspect ratio safely with 16:9 fallback', () => {
    expect(resolvePipAspectRatio(undefined)).toEqual([16, 9]);
    expect(resolvePipAspectRatio({ width: 0, height: 1080 })).toEqual([16, 9]);
    expect(resolvePipAspectRatio({ width: 1920, height: 1080 })).toEqual([1920, 1080]);
    expect(resolvePipAspectRatio({ width: 1280.4, height: 720.6 })).toEqual([1280, 721]);
  });

  it('resolves Multi-View capabilities from ThermalDevicePort and VideoHost', () => {
    expect(resolveMultiViewCapabilities(undefined, { supportsMultiView: true })).toEqual({
      platform: 'desktop',
      supported: true,
    });
    expect(resolveMultiViewCapabilities(undefined, { supportsMultiView: false })).toEqual({
      platform: 'desktop',
      supported: false,
    });
    const thermal = {
      getThermalState: () => 'nominal' as const,
      subscribeThermalState: () => () => undefined,
      getMultiViewCapabilities: () => ({
        platform: 'android' as const,
        totalMemoryBytes: 2 * 1024 * 1024 * 1024,
        supported: true,
      }),
    };
    expect(resolveMultiViewCapabilities(thermal, { supportsMultiView: true })).toMatchObject({
      platform: 'android',
      supported: true,
    });
    expect(resolveMultiViewCapabilities(thermal, { supportsMultiView: false })).toMatchObject({
      platform: 'android',
      supported: false,
    });
  });

  it('enriches Multi-View tile input with source maxConnections and accountKey', () => {
    const input = buildMultiViewTileInput(
      {
        itemKey: 'ch:1',
        sourceId: 'src-1',
        title: 'News 1',
        kind: 'live',
        logo: 'https://a.test/1.png',
      },
      SAMPLE_SOURCES,
    );
    expect(input).toMatchObject({
      itemKey: 'ch:1',
      title: 'News 1',
      sourceId: 'src-1',
      maxConnections: 1,
      providerActiveCons: 0,
      logo: 'https://a.test/1.png',
    });
    expect(input.accountKey.length).toBeGreaterThan(0);
  });

  it('maps add failures to banners and formats EN/TR copy cleanly', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const connBanner = mapAddFailureToBanner({
      ok: false,
      reason: 'connection-limit',
      activeCount: 1,
      maxConnections: 1,
    });
    expect(connBanner).toEqual({ kind: 'connection-limit', active: 1, max: 1 });
    if (connBanner !== null) {
      expect(formatMultiViewBannerText(connBanner, en).body).toContain('1 / 1');
      expect(formatMultiViewBannerText(connBanner, tr).body).toContain('1 / 1');
    }

    const serious = mapAddFailureToBanner({ ok: false, reason: 'thermal-serious' });
    expect(serious).not.toBeNull();
    if (serious !== null) expect(formatMultiViewBannerText(serious, en).tone).toBe('warning');

    const critical = mapAddFailureToBanner({ ok: false, reason: 'thermal-critical' });
    expect(critical).not.toBeNull();
    if (critical !== null) expect(formatMultiViewBannerText(critical, en).tone).toBe('danger');

    const cap = mapAddFailureToBanner({
      ok: false,
      reason: 'device-tile-cap',
      hardwareMaxTiles: 2,
    });
    expect(cap).not.toBeNull();
    if (cap !== null) expect(formatMultiViewBannerText(cap, en).title).toContain('2');

    const lowRam = mapAddFailureToBanner({ ok: false, reason: 'low-ram' });
    expect(lowRam).not.toBeNull();
    if (lowRam !== null) {
      expect(formatMultiViewBannerText(lowRam, tr).title).toContain('Çoklu Görünüm');
    }

    expect(mapAddFailureToBanner({ ok: false, reason: 'duplicate-item' })).toBeNull();
  });

  it('computes 2-tile and 4-tile grid layout, playback status mapping, and 2D TV grid focus', () => {
    expect(computeMultiViewGridLayout(1, 4, true)).toEqual({
      columns: 2,
      rows: 1,
      showEmptySlot: true,
    });
    expect(computeMultiViewGridLayout(2, 4, true)).toEqual({
      columns: 2,
      rows: 2,
      showEmptySlot: true,
    });
    expect(computeMultiViewGridLayout(2, 2, false)).toEqual({
      columns: 2,
      rows: 1,
      showEmptySlot: false,
    });

    expect(mapPlaybackStatusToTileStatus('playing')).toBe('playing');
    expect(mapPlaybackStatusToTileStatus('paused')).toBe('paused');
    expect(mapPlaybackStatusToTileStatus('failed')).toBe('error');
    expect(mapPlaybackStatusToTileStatus('tuning')).toBe('loading');

    expect(moveMultiViewGridFocus(0, 4, 'right')).toBe(1);
    expect(moveMultiViewGridFocus(0, 4, 'down')).toBe(2);
    expect(moveMultiViewGridFocus(3, 4, 'up')).toBe(1);
    expect(moveMultiViewGridFocus(1, 4, 'left')).toBe(0);
    expect(moveMultiViewGridFocus(0, 0, 'right')).toBe(0);
  });

  it('routes Wave F6 root actions in Player Settings menu', () => {
    const opts = {
      isVod: false,
      hasAspect: true,
      hasMiniPlayer: true,
      hasPip: true,
      hasMultiView: true,
      hasPopout: true,
    };
    // Root order: subtitles(0), audio(1), aspect(2), miniPlayer(3), pip(4), multiView(5), popout(6), stats(7)
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 3 },
        EMPTY_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'minimizeToMiniPlayer' });
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 4 },
        EMPTY_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'enterPip' });
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 5 },
        EMPTY_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'enterMultiView' });
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 6 },
        EMPTY_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'popoutPlayer' });
  });
});

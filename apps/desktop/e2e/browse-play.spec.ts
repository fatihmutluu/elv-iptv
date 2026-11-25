import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { mpvRuntimePaths } from '../src/main/player/runtime-path.ts';
import { type BrowseTestEnv, startBrowseTestEnv } from './browse-test-server.ts';

const DESKTOP_ROOT = join(__dirname, '..');

let env: BrowseTestEnv | undefined;

async function expectPlayingQuietly(window: Page, timeout = 15_000): Promise<void> {
  await expect(window.getByTestId('osd-status')).toHaveCount(0, { timeout });
  await expect(window.getByTestId('osd-error-hint')).toHaveCount(0);
}

function cipherLaunchArgs(): string[] {
  if (process.platform === 'darwin' && process.env.ELV_REAL_KEYCHAIN !== '1') {
    return ['--use-mock-keychain'];
  }
  if (process.platform === 'linux') {
    return ['--elv-test-cipher'];
  }
  return [];
}

test.beforeAll(async () => {
  env = await startBrowseTestEnv();
});

test.afterAll(async () => {
  await env?.close();
  env = undefined;
});

test('adds Xtream demo source, browses Live + Series, plays & zaps channels, and removes source', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-browse-play-'));
  const hasMpv =
    mpvRuntimePaths({
      isPackaged: false,
      resourcesPath: '',
      appPath: DESKTOP_ROOT,
      platform: process.platform,
      arch: process.arch,
    }) !== null;
  const canPlayMedia = hasMpv && Boolean(env?.hasMedia);

  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`, ...cipherLaunchArgs()],
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('welcome-sync-overlay')).toBeVisible();
    await window.getByTestId('welcome-continue-without-account').click();
    await expect(window.getByTestId('welcome-sync-overlay')).toHaveCount(0);
    await expect(window.getByTestId('sources-screen')).toBeVisible();

    await window.getByTestId('sources-input-server').fill(env?.frontUrl ?? '');
    await window.getByTestId('sources-input-username').fill('demo');
    await window.getByTestId('sources-input-password').fill(['de', 'mo'].join(''));
    await window.getByTestId('sources-submit').click();

    await expect(window.getByTestId('sources-open-menu')).toBeVisible({ timeout: 20_000 });

    await window.getByTestId('nav-tab-home').click();
    await expect(window.getByTestId('home-hero')).toBeVisible();
    await window.getByTestId('home-hero-mylist').click();
    await expect(window.getByTestId('home-rail-mylist')).toBeVisible();

    await window.getByTestId('nav-tab-live').click();
    await expect(window.getByTestId('live-screen')).toBeVisible();
    await expect(window.getByTestId('live-favorites-empty')).toBeVisible();
    await window.getByTestId('live-mode-channels').click();
    await expect(window.getByTestId('live-channels-grid')).toBeVisible();
    const card0 = window.getByTestId('live-channel-card-0');
    const card1 = window.getByTestId('live-channel-card-1');
    await expect(card0).toBeVisible({ timeout: 15_000 });
    await expect(card1).toBeVisible({ timeout: 15_000 });
    await expect(card0).not.toHaveText(/^(Loading…|Yükleniyor…)?$/);
    await expect(card1).not.toHaveText(/^(Loading…|Yükleniyor…)?$/);

    const ch0Label = ((await card0.getAttribute('aria-label')) ?? '').trim();
    const ch1Label = ((await card1.getAttribute('aria-label')) ?? '').trim();
    expect(ch0Label.length).toBeGreaterThan(0);
    expect(ch1Label.length).toBeGreaterThan(0);

    await card1.click();
    await expect(window.getByTestId('player-osd')).toBeVisible();
    await expect(window.getByTestId('osd-title')).toHaveText(ch1Label);

    if (hasMpv) {
      await expect(window.getByTestId('player-area')).toBeVisible();
      await expect(window.getByTestId('player-status')).toHaveCount(0);
      const isFloatingOsd = await window
        .getByTestId('player-osd')
        .evaluate((el) => getComputedStyle(el).position === 'absolute');
      if (isFloatingOsd) {
        await window.getByTestId('player-mute-button').hover();
      }
      await expect(window.getByTestId('player-volume-slider')).toBeVisible();
      const areaBox = await window.getByTestId('player-area').boundingBox();
      const osdBox = await window.getByTestId('player-osd').boundingBox();
      expect(areaBox).not.toBeNull();
      expect(osdBox).not.toBeNull();
      expect((areaBox?.height ?? 0) > 50).toBe(true);
      if (!isFloatingOsd) {
        expect((areaBox?.y ?? 0) + (areaBox?.height ?? 0)).toBeLessThanOrEqual(
          (osdBox?.y ?? 0) + 1,
        );
      }

      await window.keyboard.press('i');
      const infoDialog = window.getByTestId('player-info-desktop-dialog');
      await expect(infoDialog).toBeVisible();
      if (!isFloatingOsd) {
        const infoAreaBox = await window.getByTestId('player-area').boundingBox();
        const infoBox = await infoDialog.boundingBox();
        expect(infoAreaBox).not.toBeNull();
        expect(infoBox).not.toBeNull();
        expect((infoAreaBox?.y ?? 0) + (infoAreaBox?.height ?? 0)).toBeLessThanOrEqual(
          (infoBox?.y ?? 0) + 1,
        );
      }
      await window.keyboard.press('Escape');
      await expect(infoDialog).toHaveCount(0);
      await expect(window.getByTestId('player-osd')).toBeVisible();

      await window.getByTestId('player-channel-list-button').click();
      const channelDrawer = window.getByTestId('player-channel-drawer-desktop');
      await expect(channelDrawer).toBeVisible();
      if (!isFloatingOsd) {
        const drawerAreaBox = await window.getByTestId('player-area').boundingBox();
        const drawerBox = await channelDrawer.boundingBox();
        expect(drawerAreaBox).not.toBeNull();
        expect(drawerBox).not.toBeNull();
        expect((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0)).toBeLessThanOrEqual(
          (drawerAreaBox?.x ?? 0) + 1,
        );
      }
      await window.keyboard.press('Escape');
      await expect(channelDrawer).toHaveCount(0);
      await expect(window.getByTestId('player-osd')).toBeVisible();
    } else {
      await expect(window.getByTestId('player-area')).toHaveCount(0);
    }

    if (canPlayMedia) {
      await expectPlayingQuietly(window);
    }

    await window.getByTestId('player-prev').click();
    await expect(window.getByTestId('osd-title')).toHaveText(ch0Label);
    if (canPlayMedia) {
      await expectPlayingQuietly(window);
    }

    await window.getByTestId('player-next').click();
    await expect(window.getByTestId('osd-title')).toHaveText(ch1Label);
    if (canPlayMedia) {
      await expectPlayingQuietly(window);
    }

    await window.getByTestId('player-back').click();
    await expect(window.getByTestId('live-screen')).toBeVisible();

    await window.getByTestId('live-mode-epg').click();
    await expect(window.getByTestId('live-epg-view')).toBeVisible();
    await expect(window.getByTestId('epg-preview-header')).toBeVisible();
    await expect(window.getByTestId('epg-time-ruler')).toBeVisible();
    await window.getByTestId('epg-favorite-toggle').click();

    await window.getByTestId('live-mode-favorites').click();
    await expect(window.getByTestId('live-watch-stage')).toBeVisible();
    await expect(window.getByTestId('live-zap-drawer')).toBeVisible();

    await window.getByTestId('nav-tab-series').click();
    await expect(window.getByTestId('catalog-screen-series')).toBeVisible();
    const seriesItem0 = window.getByTestId('catalog-rail-0-item-0');
    await expect(seriesItem0).toBeVisible({ timeout: 15_000 });
    await seriesItem0.click();

    await expect(window.getByTestId('detail-screen')).toBeVisible();
    await expect(window.getByTestId('detail-season-1')).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId('detail-episode-0')).toBeVisible({ timeout: 15_000 });
    await window.getByTestId('detail-episode-0').click();

    await expect(window.getByTestId('player-osd')).toBeVisible();
    if (canPlayMedia) {
      await expectPlayingQuietly(window);
    }
    await window.getByTestId('player-back').click();
    await expect(window.getByTestId('detail-screen')).toBeVisible();
    await expect(window.getByTestId('detail-episode-0')).toBeVisible();

    await window.getByTestId('nav-tab-search').click();
    await expect(window.getByTestId('search-screen')).toBeVisible();
    await window.getByTestId('search-input').fill('Movie 0001');
    const searchMovie0 = window.getByTestId('search-movie-item-0');
    await expect(searchMovie0).toBeVisible({ timeout: 10_000 });
    await searchMovie0.click();
    await expect(window.getByTestId('detail-screen')).toBeVisible();
    await window.getByTestId('detail-back').click();
    await expect(window.getByTestId('search-screen')).toBeVisible();

    await window.getByTestId('nav-tab-settings').click();
    await expect(window.getByTestId('settings-screen')).toBeVisible();
    await window.getByTestId('settings-tab-appearance').click();
    await window.getByTestId('settings-lang-tr').click();
    await expect(window.getByTestId('settings-tab-appearance')).toHaveText('Görünüm');
    await expect(window.getByTestId('nav-tab-live')).toHaveText('Canlı');
    await window.getByTestId('settings-lang-en').click();
    await expect(window.getByTestId('settings-tab-appearance')).toHaveText('Appearance');
    await window.getByTestId('settings-theme-highContrast').click();
    await expect(window.getByTestId('settings-theme-highContrast')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await window.getByTestId('settings-tab-sources').click();
    await expect(window.getByTestId('sources-screen')).toBeVisible();
    await window.locator('[data-testid^="source-remove-"]').first().click();
    await expect(window.getByTestId('sources-empty')).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('plays corpus Two audio tracks and subtitles (MKV) movie, pauses, seeks +10s, switches audio & subtitles, and keeps position > 10s', async () => {
  const hasMpv =
    mpvRuntimePaths({
      isPackaged: false,
      resourcesPath: '',
      appPath: DESKTOP_ROOT,
      platform: process.platform,
      arch: process.arch,
    }) !== null;
  if (!hasMpv || !env?.hasMedia) {
    test.skip(true, 'mpv runtime or FFmpeg test media is unavailable');
    return;
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-vod-controls-'));
  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`, ...cipherLaunchArgs()],
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('welcome-sync-overlay')).toBeVisible();
    await window.getByTestId('welcome-continue-without-account').click();
    await expect(window.getByTestId('welcome-sync-overlay')).toHaveCount(0);
    await expect(window.getByTestId('sources-screen')).toBeVisible();

    await window.getByTestId('sources-input-server').fill(env.frontUrl);
    await window.getByTestId('sources-input-username').fill('corpus');
    await window.getByTestId('sources-input-password').fill(['cor', 'pus'].join(''));
    await window.getByTestId('sources-submit').click();
    await expect(window.getByTestId('sources-open-menu')).toBeVisible({ timeout: 20_000 });

    await window.getByTestId('nav-tab-movie').click();
    await expect(window.getByTestId('catalog-screen-movie')).toBeVisible();
    await window
      .locator('[data-testid^="catalog-cat-chip-"]', { hasText: 'Tracks and subtitles' })
      .click();
    await expect(window.getByTestId('catalog-grid')).toBeVisible();
    await window
      .getByTestId('catalog-grid')
      .getByText('Two audio tracks and subtitles (MKV)', { exact: false })
      .click();

    await expect(window.getByTestId('detail-screen')).toBeVisible();
    await window.getByTestId('detail-play').click();

    await expect(window.getByTestId('player-osd')).toBeVisible();
    await expectPlayingQuietly(window);

    await window.getByTestId('player-play-pause').click();
    await expect(window.getByTestId('osd-status')).toHaveText(/^(Paused|Duraklatıldı)$/, {
      timeout: 10_000,
    });

    await window.getByTestId('player-seek-forward').click();
    await window.getByTestId('player-play-pause').click();
    await expectPlayingQuietly(window, 10_000);

    await expect(window.getByTestId('player-tracks-button')).toBeVisible({ timeout: 10_000 });
    await window.getByTestId('player-tracks-button').click();
    await expect(window.getByTestId('player-tracks-panel')).toBeVisible();

    const isFloatingOsd = await window
      .getByTestId('player-osd')
      .evaluate((el) => getComputedStyle(el).position === 'absolute');
    if (!isFloatingOsd) {
      const areaBox = await window.getByTestId('player-area').boundingBox();
      const panelBox = await window.getByTestId('player-tracks-panel').boundingBox();
      expect(areaBox).not.toBeNull();
      expect(panelBox).not.toBeNull();
      expect((areaBox?.y ?? 0) + (areaBox?.height ?? 0)).toBeLessThanOrEqual(
        (panelBox?.y ?? 0) + 1,
      );
    }

    await window.getByTestId('player-audio-track-a:2').click();
    await expect(window.getByTestId('player-audio-track-a:2')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await window.getByTestId('player-subtitle-track-s:1').click();
    await expect(window.getByTestId('player-subtitle-track-s:1')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await window.getByTestId('player-subtitle-off').click();
    await expect(window.getByTestId('player-subtitle-off')).toHaveAttribute('aria-checked', 'true');

    await window.keyboard.press('Escape');
    await expect(window.getByTestId('player-tracks-panel')).toHaveCount(0);
    await expect(window.getByTestId('player-osd')).toBeVisible();

    await expect
      .poll(async () => {
        const elapsed =
          (await window.getByTestId('player-progress-time-current').textContent())?.trim() ?? '';
        const parts = elapsed.split(':').map(Number);
        if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return -1;
        return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
      })
      .toBeGreaterThanOrEqual(10);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

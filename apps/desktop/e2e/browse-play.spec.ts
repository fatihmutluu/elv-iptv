import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { mpvRuntimePaths } from '../src/main/player/runtime-path.ts';
import { type BrowseTestEnv, startBrowseTestEnv } from './browse-test-server.ts';

const DESKTOP_ROOT = join(__dirname, '..');

let env: BrowseTestEnv | undefined;

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
    await expect(window.getByTestId('sources-screen')).toBeVisible();

    await window.getByTestId('sources-input-server').fill(env?.frontUrl ?? '');
    await window.getByTestId('sources-input-username').fill('demo');
    await window.getByTestId('sources-input-password').fill(['de', 'mo'].join(''));
    await window.getByTestId('sources-submit').click();

    await expect(window.getByTestId('sources-open-menu')).toBeVisible({ timeout: 20_000 });

    await window.getByTestId('nav-tab-live').click();
    await expect(window.getByTestId('browse-categories-list')).toBeVisible();
    const row0 = window.getByTestId('browse-items-list-row-0');
    const row1 = window.getByTestId('browse-items-list-row-1');
    await expect(row0).toBeVisible();
    await expect(row1).toBeVisible();
    await expect(row0).not.toHaveText(/^(Loading…|Yükleniyor…)?$/);
    await expect(row1).not.toHaveText(/^(Loading…|Yükleniyor…)?$/);

    const ch0Label = (await row0.textContent()) ?? '';
    const ch1Label = (await row1.textContent()) ?? '';
    expect(ch0Label.length).toBeGreaterThan(0);
    expect(ch1Label.length).toBeGreaterThan(0);

    await window.getByTestId('browse-items-list-row-0').focus();
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('player-osd')).toBeVisible();
    await expect(window.getByTestId('osd-title')).toHaveText(ch1Label.trim());

    if (hasMpv) {
      await expect(window.getByTestId('player-area')).toBeVisible();
      await expect(window.getByTestId('player-status')).toHaveCount(0);
      const areaBox = await window.getByTestId('player-area').boundingBox();
      const osdBox = await window.getByTestId('player-osd').boundingBox();
      expect(areaBox).not.toBeNull();
      expect(osdBox).not.toBeNull();
      expect((areaBox?.height ?? 0) > 50).toBe(true);
      expect((areaBox?.y ?? 0) + (areaBox?.height ?? 0)).toBeLessThanOrEqual((osdBox?.y ?? 0) + 1);
    } else {
      await expect(window.getByTestId('player-area')).toHaveCount(0);
    }

    if (canPlayMedia) {
      await expect(window.getByTestId('osd-status')).toHaveText(/^(Playing|Oynatılıyor)$/, {
        timeout: 15_000,
      });
    }

    await window.getByTestId('player-prev').click();
    await expect(window.getByTestId('osd-title')).toHaveText(ch0Label.trim());
    if (canPlayMedia) {
      await expect(window.getByTestId('osd-status')).toHaveText(/^(Playing|Oynatılıyor)$/, {
        timeout: 15_000,
      });
    }

    await window.getByTestId('player-next').click();
    await expect(window.getByTestId('osd-title')).toHaveText(ch1Label.trim());
    if (canPlayMedia) {
      await expect(window.getByTestId('osd-status')).toHaveText(/^(Playing|Oynatılıyor)$/, {
        timeout: 15_000,
      });
    }

    await window.getByTestId('player-back').click();
    await expect(window.getByTestId('browse-items-list-row-1')).toBeVisible();

    await window.getByTestId('nav-tab-series').click();
    const seriesRow0 = window.getByTestId('browse-items-list-row-0');
    await expect(seriesRow0).toBeVisible();
    await expect(seriesRow0).not.toHaveText(/^(Loading…|Yükleniyor…)?$/);
    await seriesRow0.click();

    await expect(window.getByTestId('series-seasons-list-row-0')).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId('series-episodes-list-row-0')).toBeVisible({ timeout: 15_000 });
    await window.getByTestId('series-episodes-list-row-0').click();

    await expect(window.getByTestId('player-osd')).toBeVisible();
    if (canPlayMedia) {
      await expect(window.getByTestId('osd-status')).toHaveText(/^(Playing|Oynatılıyor)$/, {
        timeout: 15_000,
      });
    }
    await window.getByTestId('player-back').click();
    await expect(window.getByTestId('series-episodes-list-row-0')).toBeVisible();

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
    await expect(window.getByTestId('sources-screen')).toBeVisible();

    await window.getByTestId('sources-input-server').fill(env.frontUrl);
    await window.getByTestId('sources-input-username').fill('corpus');
    await window.getByTestId('sources-input-password').fill(['cor', 'pus'].join(''));
    await window.getByTestId('sources-submit').click();
    await expect(window.getByTestId('sources-open-menu')).toBeVisible({ timeout: 20_000 });

    await window.getByTestId('nav-tab-movie').click();
    await expect(window.getByTestId('browse-categories-list')).toBeVisible();
    await window
      .getByTestId('browse-categories-list')
      .getByText('Tracks and subtitles', { exact: false })
      .click();
    await window
      .getByTestId('browse-items-list')
      .getByText('Two audio tracks and subtitles (MKV)', { exact: false })
      .click();

    await expect(window.getByTestId('player-osd')).toBeVisible();
    await expect(window.getByTestId('osd-status')).toHaveText(/^(Playing|Oynatılıyor)$/, {
      timeout: 15_000,
    });

    await window.getByTestId('player-play-pause').click();
    await expect(window.getByTestId('osd-status')).toHaveText(/^(Paused|Duraklatıldı)$/, {
      timeout: 10_000,
    });

    await window.getByTestId('player-seek-forward').click();
    await window.getByTestId('player-play-pause').click();
    await expect(window.getByTestId('osd-status')).toHaveText(/^(Playing|Oynatılıyor)$/, {
      timeout: 10_000,
    });

    await expect(window.getByTestId('player-tracks-button')).toBeVisible({ timeout: 10_000 });
    await window.getByTestId('player-tracks-button').click();
    await expect(window.getByTestId('player-tracks-panel')).toBeVisible();

    const areaBox = await window.getByTestId('player-area').boundingBox();
    const panelBox = await window.getByTestId('player-tracks-panel').boundingBox();
    expect(areaBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect((areaBox?.y ?? 0) + (areaBox?.height ?? 0)).toBeLessThanOrEqual((panelBox?.y ?? 0) + 1);

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
        const text = (await window.getByTestId('player-progress-time').textContent()) ?? '';
        const elapsed = text.split('/')[0]?.trim() ?? '';
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

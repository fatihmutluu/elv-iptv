import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('opens a window titled ELV IPTV that mounts SourcesScreen on desktop', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-app-'));
  const app = await electron.launch({
    args: [join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
  });
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('ELV IPTV');
    await expect(window.getByTestId('welcome-sync-overlay')).toBeVisible();
    await window.getByTestId('welcome-continue-without-account').click();
    await expect(window.getByTestId('welcome-sync-overlay')).toHaveCount(0);
    await expect(window.getByTestId('onboarding-source-step')).toBeVisible();
    await window.getByTestId('onboarding-browse-without-source').click();
    await expect(window.getByTestId('onboarding-flow-overlay')).toHaveCount(0);
    await expect(window.getByText('ELV IPTV', { exact: true })).toBeVisible();
    await expect(window.getByTestId('sources-screen')).toBeVisible();
    await expect(window.getByTestId('sources-layout-desktop')).toBeVisible();
    await expect(window.getByTestId('sources-submit')).toBeVisible();
    const hasNodeRequire = await window.evaluate(
      () => typeof (globalThis as { require?: unknown }).require !== 'undefined',
    );
    expect(hasNodeRequire).toBe(false);

    await window.getByTestId('settings-tab-licenses').click();
    await expect(window.getByTestId('notices-screen')).toBeVisible();
    await expect(window.getByTestId('notices-item-desktop-libmpv')).toBeVisible();
    await expect(window.getByTestId('notices-detail-name')).toContainText('AetherEngine');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

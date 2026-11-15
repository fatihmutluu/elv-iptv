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
    await expect(window.getByText('ELV IPTV')).toBeVisible();
    await expect(window.getByTestId('sources-screen')).toBeVisible();
    await expect(window.getByTestId('sources-layout-desktop')).toBeVisible();
    await expect(window.getByTestId('sources-submit')).toBeVisible();
    const hasNodeRequire = await window.evaluate(
      () => typeof (globalThis as { require?: unknown }).require !== 'undefined',
    );
    expect(hasNodeRequire).toBe(false);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

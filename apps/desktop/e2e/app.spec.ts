import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('opens a window titled ELV IPTV that shows the app name', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..')] });
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('ELV IPTV');
    await expect(window.getByText('ELV IPTV')).toBeVisible();
    const hasNodeRequire = await window.evaluate(
      () => typeof (globalThis as { require?: unknown }).require !== 'undefined',
    );
    expect(hasNodeRequire).toBe(false);
  } finally {
    await app.close();
  }
});

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, expect, type Page, test } from '@playwright/test';

const DESKTOP_ROOT = join(__dirname, '..');

function candidateBinaries(platform: NodeJS.Platform): string[] {
  if (process.env.ELV_PACKAGED_BINARY) return [process.env.ELV_PACKAGED_BINARY];
  if (platform === 'win32') {
    return [
      join(DESKTOP_ROOT, 'release', 'win-unpacked', 'ELV IPTV.exe'),
      join(DESKTOP_ROOT, 'release', 'win-arm64-unpacked', 'ELV IPTV.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      join(DESKTOP_ROOT, 'release', 'mac-arm64', 'ELV IPTV.app', 'Contents', 'MacOS', 'ELV IPTV'),
      join(DESKTOP_ROOT, 'release', 'mac', 'ELV IPTV.app', 'Contents', 'MacOS', 'ELV IPTV'),
      join(
        DESKTOP_ROOT,
        'release',
        'mac-universal',
        'ELV IPTV.app',
        'Contents',
        'MacOS',
        'ELV IPTV',
      ),
    ];
  }
  return [
    join(DESKTOP_ROOT, 'release', 'linux-unpacked', 'elv-iptv'),
    join(DESKTOP_ROOT, 'release', 'linux-arm64-unpacked', 'elv-iptv'),
  ];
}

function findPackagedBinary(): string | undefined {
  return candidateBinaries(process.platform).find((candidate) => existsSync(candidate));
}

function packagedResourcesDir(binaryPath: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return join(dirname(binaryPath), '..', 'Resources');
  return join(dirname(binaryPath), 'resources');
}

function requirePackagedBinary(): string | undefined {
  const binary = findPackagedBinary();
  if (!binary) {
    if (process.env.ELV_E2E_PACKAGED === '1') {
      throw new Error(
        `ELV_E2E_PACKAGED=1 but no packaged binary found in: ${candidateBinaries(process.platform).join(', ')}`,
      );
    }
    test.skip(true, 'Packaged binary not built; run `pnpm --filter @elv/desktop build` first.');
    return undefined;
  }
  return binary;
}

/**
 * Launches the packaged Electron binary directly and attaches over Chromium CDP (`--remote-debugging-port=0`)
 * because production Electron fuses disable `--inspect` (`enableNodeCliInspectArguments: false`), which
 * Playwright's `_electron.launch` requires.
 */
function launchWithCdp(
  executablePath: string,
  userDataDir: string,
): Promise<{ child: ChildProcess; wsUrl: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;

    const child = spawn(
      executablePath,
      ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`],
      {
        cwd: DESKTOP_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error(`Timed out waiting for DevTools endpoint.\n${stderr}`));
    }, 30_000);

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new Error(
          `Packaged binary exited before opening DevTools (code=${String(code)}, signal=${String(signal)}).\n${stderr}`,
        ),
      );
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match?.[1] && !settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ child, wsUrl: match[1] });
      }
    });
  });
}

async function firstAppPage(wsUrl: string): Promise<{ close: () => Promise<void>; page: Page }> {
  const browser = await chromium.connectOverCDP(wsUrl);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const page = context.pages()[0];
      if (page) {
        return {
          close: async () => {
            await page.evaluate(() => window.close()).catch(() => {});
            await browser.close().catch(() => {});
          },
          page,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await browser.close();
  throw new Error('Packaged app opened DevTools but created no BrowserWindow page within 15s');
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
  });
  // Allow graceful `window.close()` -> `window-all-closed` -> `before-quit` to finish first on non-macOS.
  if (process.platform !== 'darwin') {
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2_000))]);
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
}

function removeUserDataDir(userDataDir: string): void {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test('the packaged app ships the runtime', () => {
  if (process.platform === 'linux') {
    test.skip(true, 'Linux mpv runtime is not bundled in 0.1');
    return;
  }
  const binary = requirePackagedBinary();
  if (!binary) return;

  const resources = packagedResourcesDir(binary, process.platform);
  expect(existsSync(join(resources, 'mpv-input.conf'))).toBe(true);
  if (process.platform === 'win32') {
    for (const file of ['elv-mpv.exe', 'libmpv-2.dll', 'LICENSE.LGPL', 'BUILDINFO.json']) {
      expect(existsSync(join(resources, 'mpv', file))).toBe(true);
    }
  } else {
    expect(
      existsSync(join(resources, 'mpv', 'ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv')),
    ).toBe(true);
    expect(existsSync(join(resources, 'mpv', 'BUILDINFO.json'))).toBe(true);
  }
});

test('packaged desktop binary boots from app.asar, opens engine and catalog utility process', async () => {
  const binary = requirePackagedBinary();
  if (!binary) return;

  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-packaged-'));
  const { child, wsUrl } = await launchWithCdp(binary, userDataDir);
  let closeBrowser: (() => Promise<void>) | undefined;
  try {
    const connected = await firstAppPage(wsUrl);
    closeBrowser = connected.close;
    const { page } = connected;

    await test.step('boots from app.asar with production fuses enabled', async () => {
      await expect(page).toHaveTitle('ELV IPTV');
      await expect(page.getByText('ELV IPTV')).toBeVisible();
      expect(page.url().toLowerCase()).toBe('app://elv/');

      const hasNodeRequire = await page.evaluate(
        () => typeof (globalThis as { require?: unknown }).require !== 'undefined',
      );
      expect(hasNodeRequire).toBe(false);
    });

    if (process.platform !== 'linux') {
      await test.step('opens an engine', async () => {
        const opened = await page.evaluate(async () => {
          const w = window as unknown as {
            elv: {
              player: {
                open(): Promise<{ engineId: string; mainNowMs: number }>;
                close(engineId: string): Promise<void>;
              };
            };
          };
          const reply = await w.elv.player.open();
          await w.elv.player.close(reply.engineId);
          return reply;
        });

        expect(typeof opened.engineId).toBe('string');
        expect(opened.engineId.length).toBeGreaterThan(0);
        expect(Number.isFinite(opened.mainNowMs)).toBe(true);
      });
    }

    await test.step('opens the catalog utility process and queries SQLite', async () => {
      const result = await page.evaluate(async () => {
        const w = window as unknown as {
          elv: {
            catalog: {
              open(): Promise<{ ok: boolean; error?: { category: string; code: string } }>;
              listSources(): Promise<unknown[]>;
              categories(sourceId: string, kind: 'live' | 'movie' | 'series'): Promise<unknown[]>;
              items(categoryId: string, offset: number, limit: number): Promise<unknown[]>;
              close(): Promise<void>;
            };
          };
        };
        const opened = await w.elv.catalog.open();
        const sources = await w.elv.catalog.listSources();
        const cats = await w.elv.catalog.categories('none', 'live');
        const items = await w.elv.catalog.items('none', 0, 10);
        await w.elv.catalog.close();
        return { opened, sources, cats, items };
      });

      expect(result).toEqual({
        opened: { ok: true, value: undefined },
        sources: [],
        cats: [],
        items: [],
      });
      expect(existsSync(join(userDataDir, 'catalog.db'))).toBe(true);
    });
  } finally {
    await closeBrowser?.().catch(() => {});
    await stopProcess(child);
    removeUserDataDir(userDataDir);
  }
});

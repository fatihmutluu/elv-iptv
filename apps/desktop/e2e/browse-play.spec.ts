import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { mpvRuntimePaths } from '../src/main/player/runtime-path.ts';

const DESKTOP_ROOT = join(__dirname, '..');
const SIM_BIN = join(DESKTOP_ROOT, '..', '..', 'tools', 'bin', 'sim.ts');

let ownedSim: ChildProcess | undefined;
let simBaseUrl = '';
let frontServer: Server | undefined;
let frontUrl = '';
let mediaDir = '';
let liveTsPath = '';
let vodMp4Path = '';
let hasMedia = false;

function spawnEphemeralSim(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SIM_BIN, '--port', '0', '--host', '127.0.0.1', '--clock', '2026-06-15T12:00:00Z'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out starting local simulator.\n${out}`));
    }, 15_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /sim:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    });
  });
}

function generateTestClips(dir: string): { liveTs: string; vodMp4: string } | null {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const probe = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore' });
  if (probe.status !== 0) return null;

  const baseArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '12',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
  ];
  const liveTs = join(dir, 'live.ts');
  const vodMp4 = join(dir, 'vod.mp4');

  const tsOut = spawnSync(ffmpeg, [...baseArgs, '-f', 'mpegts', liveTs], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (tsOut.status !== 0) return null;

  const mp4Out = spawnSync(ffmpeg, [...baseArgs, '-movflags', '+faststart', '-f', 'mp4', vodMp4], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (mp4Out.status !== 0) return null;

  return { liveTs, vodMp4 };
}

function serveStaticClip(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
  const size = statSync(file).size;
  res.writeHead(200, {
    'content-type': mime,
    'content-length': String(size),
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  res.once('close', () => stream.destroy());
  stream.pipe(res);
}

async function proxyToSim(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const upstream = await fetch(`${simBaseUrl}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
    });
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, headers);
    res.end(buf);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
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
  const started = await spawnEphemeralSim();
  ownedSim = started.child;
  simBaseUrl = started.url;

  mediaDir = mkdtempSync(join(tmpdir(), 'elv-e2e-browse-media-'));
  const clips = generateTestClips(mediaDir);
  if (clips) {
    liveTsPath = clips.liveTs;
    vodMp4Path = clips.vodMp4;
    hasMedia = true;
  }

  frontServer = createServer((req, res) => {
    const path = req.url ?? '/';
    if (hasMedia && path.startsWith('/live/')) {
      serveStaticClip(req, res, liveTsPath, 'video/mp2t');
      return;
    }
    if (hasMedia && (path.startsWith('/movie/') || path.startsWith('/series/'))) {
      serveStaticClip(req, res, vodMp4Path, 'video/mp4');
      return;
    }
    void proxyToSim(req, res);
  });
  await new Promise<void>((resolve) => frontServer?.listen(0, '127.0.0.1', resolve));
  const addr = frontServer.address();
  if (typeof addr === 'object' && addr !== null) {
    frontUrl = `http://127.0.0.1:${addr.port}`;
  }
});

test.afterAll(async () => {
  await new Promise<void>((resolve) =>
    frontServer ? frontServer.close(() => resolve()) : resolve(),
  );
  if (ownedSim && ownedSim.exitCode === null) {
    const exited = new Promise<void>((resolve) => ownedSim?.once('exit', () => resolve()));
    ownedSim.kill();
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3_000))]);
  }
  ownedSim = undefined;
  if (mediaDir) {
    rmSync(mediaDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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
    }) !== undefined;
  const canPlayMedia = hasMpv && hasMedia;

  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`, ...cipherLaunchArgs()],
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('sources-screen')).toBeVisible();

    await window.getByTestId('sources-input-server').fill(frontUrl);
    await window.getByTestId('sources-input-username').fill('demo');
    await window.getByTestId('sources-input-password').fill(['de', 'mo'].join(''));
    await window.getByTestId('sources-submit').click();

    await expect(window.getByTestId('sources-open-menu')).toBeVisible({ timeout: 20_000 });

    await window.getByTestId('nav-tab-live').click();
    await expect(window.getByTestId('browse-categories-list')).toBeVisible();
    await expect(window.getByTestId('browse-items-list-row-0')).toBeVisible();

    const ch0Label = (await window.getByTestId('browse-items-list-row-0').textContent()) ?? '';
    const ch1Label = (await window.getByTestId('browse-items-list-row-1').textContent()) ?? '';
    expect(ch0Label.length).toBeGreaterThan(0);
    expect(ch1Label.length).toBeGreaterThan(0);

    await window.getByTestId('browse-items-list-row-0').focus();
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('player-osd')).toBeVisible();
    await expect(window.getByTestId('osd-title')).toHaveText(ch1Label.trim());

    await expect(window.getByTestId('player-area')).toBeVisible();
    await expect(window.getByTestId('player-status')).toHaveCount(0);
    const areaBox = await window.getByTestId('player-area').boundingBox();
    const osdBox = await window.getByTestId('player-osd').boundingBox();
    expect(areaBox).not.toBeNull();
    expect(osdBox).not.toBeNull();
    expect((areaBox?.height ?? 0) > 50).toBe(true);
    expect((areaBox?.y ?? 0) + (areaBox?.height ?? 0)).toBeLessThanOrEqual((osdBox?.y ?? 0) + 1);

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
    await expect(window.getByTestId('browse-items-list-row-0')).toBeVisible();
    await window.getByTestId('browse-items-list-row-0').click();

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

    await window.getByTestId('nav-tab-sources').click();
    await expect(window.getByTestId('sources-screen')).toBeVisible();
    await window.locator('[data-testid^="source-remove-"]').first().click();
    await expect(window.getByTestId('sources-empty')).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

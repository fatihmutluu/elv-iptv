import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { CatalogBridge } from '../src/shared/catalog-ipc.ts';

const DESKTOP_ROOT = join(__dirname, '..');
const SIM_BIN = join(DESKTOP_ROOT, '..', '..', 'tools', 'bin', 'sim.ts');

// Assembled at runtime so no literal token-shaped string sits in source to trip gitleaks.
const SYNTH_M3U_VAL = ['m3u', 'E2e', '9f8e7d6c'].join('_');
const SYNTH_AUTH_VAL = ['Bearer', ['hdr', 'E2e', '1a2b3c4d'].join('_')].join(' ');
const SYNTH_GUIDE_VAL = ['guide', 'E2e', '554433'].join('_');
const SYNTH_XTREAM_ACCT = ['acct', 'E2e', '8899'].join('_');
const SYNTH_XTREAM_VAL = ['xtream', 'E2e', '776655'].join('_');

let ownedSim: ChildProcess | undefined;
let simBaseUrl = '';
let m3uServer: Server | undefined;
let m3uBaseUrl = '';
let hangRequested = false;
const hangingResponses = new Set<ServerResponse>();

async function urlAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/_sim/requests`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

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

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function cipherLaunchArgs(): string[] {
  if (process.platform === 'darwin' && process.env['ELV_REAL_KEYCHAIN'] !== '1') {
    return ['--use-mock-keychain'];
  }
  if (process.platform === 'linux') {
    return ['--elv-test-cipher'];
  }
  return [];
}

test.beforeAll(async () => {
  const explicit = process.env['ELV_CATALOG_SIM_URL'] ?? process.env['ELV_SIM_URL'];
  if (explicit && (await urlAnswers(explicit))) {
    simBaseUrl = explicit;
  } else {
    const started = await spawnEphemeralSim();
    ownedSim = started.child;
    simBaseUrl = started.url;
  }

  m3uServer = createServer((req, res) => {
    if (req.url?.startsWith('/playlist.m3u')) {
      const body = [
        `#EXTM3U url-tvg="http://guide.example/epg.xml?token=${SYNTH_GUIDE_VAL}"`,
        `#EXTINF:-1 tvg-id="ch1" tvg-logo="http://cdn.example/logo1.png?token=${SYNTH_M3U_VAL}" group-title="News",Channel One`,
        `#EXTVLCOPT:http-referrer=http://ref.example/page?token=${SYNTH_M3U_VAL}`,
        `#EXTHTTP:{"Authorization":"${SYNTH_AUTH_VAL}"}`,
        `http://stream.example/live/${SYNTH_M3U_VAL}/101.ts`,
        `#EXTINF:-1 tvg-id="ch2" group-title="News",Channel Two`,
        `http://stream.example/live/${SYNTH_M3U_VAL}/102.ts`,
        '',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.url?.startsWith('/hang.m3u')) {
      hangRequested = true;
      hangingResponses.add(res);
      res.once('close', () => hangingResponses.delete(res));
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
      res.write('#EXTM3U\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => m3uServer?.listen(0, '127.0.0.1', resolve));
  const addr = m3uServer.address();
  if (typeof addr === 'object' && addr !== null) {
    m3uBaseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

test.afterAll(async () => {
  if (ownedSim && ownedSim.exitCode === null) {
    const exited = new Promise<void>((resolve) => ownedSim?.once('exit', () => resolve()));
    ownedSim.kill();
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3_000))]);
  }
  for (const res of hangingResponses) res.destroy();
  hangingResponses.clear();
  await new Promise<void>((resolve) => (m3uServer ? m3uServer.close(() => resolve()) : resolve()));
});

test('imports the large simulator catalog in utilityProcess without stalling renderer and stores zero plaintext credentials on disk', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-catalog-large-'));
  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`, ...cipherLaunchArgs()],
  });

  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('ELV IPTV');

    // Catalog utilityProcess spawns lazily on first catalog request
    const beforeOpenPid = await app.evaluate(({ app: electronApp }) => {
      const m = electronApp
        .getAppMetrics()
        .find(
          (p) =>
            p.type === 'Utility' &&
            (p.name === 'ELV Catalog' ||
              p.serviceName === 'ELV Catalog' ||
              p.serviceName === 'node.mojom.NodeService'),
        );
      return m?.pid ?? null;
    });
    expect(beforeOpenPid).toBeNull();

    const runResult = await page.evaluate(
      async (params) => {
        const catalog = (globalThis as unknown as { elv?: { catalog: CatalogBridge } }).elv
          ?.catalog;
        if (!catalog) throw new Error('window.elv.catalog missing');

        const opened = await catalog.open();
        if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);

        const addedLarge = await catalog.addSource({
          kind: 'xtream',
          name: 'Large Sim',
          server: params.simUrl,
          username: 'large',
          password: 'large',
        });
        if (!addedLarge.ok) throw new Error(`addSource large failed: ${addedLarge.error.code}`);

        const addedSecretXtream = await catalog.addSource({
          kind: 'xtream',
          name: 'Credential Isolation Check',
          server: 'http://panel.example:8080',
          username: params.xtreamUser,
          password: params.xtreamPass,
        });
        if (!addedSecretXtream.ok) {
          throw new Error(`addSource secret check failed: ${addedSecretXtream.error.code}`);
        }

        const addedM3u = await catalog.addSourceFromLink({
          name: 'Tokenized M3U',
          url: `${params.m3uUrl}/playlist.m3u?auth=${params.m3uTok}`,
          guideUrl: `http://guide.example/override.xml?token=${params.guideTok}`,
        });
        if (!addedM3u.ok) throw new Error(`addSourceFromLink failed: ${addedM3u.error.code}`);

        // Measure renderer event-loop responsiveness while 95,500+ items import in utilityProcess
        let lastTick = performance.now();
        let maxStallMs = 0;
        let ticks = 0;
        const interval = setInterval(() => {
          const now = performance.now();
          const stall = Math.max(0, now - lastTick - 16);
          if (stall > maxStallMs) maxStallMs = stall;
          lastTick = now;
          ticks += 1;
        }, 16);

        let progressEvents = 0;
        const t0 = performance.now();
        let largeRes: Awaited<ReturnType<typeof catalog.startImport>['result']>;
        try {
          largeRes = await catalog.startImport(addedLarge.value.id, {
            batchSize: 5000,
            onProgress: () => {
              progressEvents += 1;
            },
          }).result;
        } finally {
          clearInterval(interval);
        }
        const importDurationMs = Math.round(performance.now() - t0);
        if (!largeRes.ok) throw new Error(`large import failed: ${largeRes.error.code}`);

        const m3uRes = await catalog.startImport(addedM3u.value.id).result;
        if (!m3uRes.ok) throw new Error(`m3u import failed: ${m3uRes.error.code}`);

        const sources = await catalog.listSources();
        const liveCats = await catalog.categories(addedLarge.value.id, 'live');
        const movieCats = await catalog.categories(addedLarge.value.id, 'movie');
        const seriesCats = await catalog.categories(addedLarge.value.id, 'series');
        const firstLiveItems = await catalog.items(liveCats[0]?.id ?? '', 0, 25);
        const firstSeriesItems = await catalog.items(seriesCats[0]?.id ?? '', 0, 5);
        const seasons = await catalog.seasons(firstSeriesItems[0]?.id ?? 0);
        const firstSeasonNum = seasons.ok ? (seasons.value[0]?.season ?? 1) : 1;
        const episodes = await catalog.episodes(firstSeriesItems[0]?.id ?? 0, firstSeasonNum);
        const resolvedLarge = await catalog.resolveStream(firstLiveItems[0]?.key ?? '');

        const m3uCats = await catalog.categories(addedM3u.value.id, 'live');
        const m3uItems = await catalog.items(m3uCats[0]?.id ?? '', 0, 10);
        const resolvedM3u = await catalog.resolveStream(m3uItems[0]?.key ?? '');

        return {
          importDurationMs,
          maxStallMs: Math.round(maxStallMs * 100) / 100,
          ticks,
          progressEvents,
          counts: largeRes.value.counts,
          sourceNames: sources.map((s) => s.name),
          liveCatCount: liveCats.length,
          movieCatCount: movieCats.length,
          seriesCatCount: seriesCats.length,
          firstPageCount: firstLiveItems.length,
          seasonsOk: seasons.ok,
          episodeCount: episodes.length,
          resolvedLargeUrl: resolvedLarge.ok ? resolvedLarge.value.url : '',
          resolvedM3u: resolvedM3u.ok ? resolvedM3u.value : null,
        };
      },
      {
        simUrl: simBaseUrl,
        m3uUrl: m3uBaseUrl,
        m3uTok: SYNTH_M3U_VAL,
        guideTok: SYNTH_GUIDE_VAL,
        xtreamUser: SYNTH_XTREAM_ACCT,
        xtreamPass: SYNTH_XTREAM_VAL,
      },
    );

    process.stdout.write(
      `ELV_DESKTOP_CATALOG_E2E ${JSON.stringify({
        platform: process.platform,
        importDurationMs: runResult.importDurationMs,
        maxStallMs: runResult.maxStallMs,
        ticks: runResult.ticks,
        progressEvents: runResult.progressEvents,
        counts: runResult.counts,
      })}\n`,
    );

    // Confirm catalog runs inside an isolated Utility process
    const utilityMetrics = await app.evaluate(({ app: electronApp }) =>
      electronApp
        .getAppMetrics()
        .filter(
          (m) =>
            m.type === 'Utility' &&
            (m.name === 'ELV Catalog' ||
              m.serviceName === 'ELV Catalog' ||
              m.serviceName === 'node.mojom.NodeService'),
        )
        .map((m) => ({ pid: m.pid, type: m.type, name: m.name, serviceName: m.serviceName })),
    );
    expect(utilityMetrics).toHaveLength(1);

    expect(runResult.counts['live']).toBe(25_000);
    expect(runResult.counts['movies']).toBe(70_000);
    expect(runResult.counts['series']).toBe(500);
    expect(runResult.progressEvents).toBeGreaterThan(10);
    expect(runResult.ticks).toBeGreaterThan(5);
    expect(runResult.maxStallMs).toBeLessThan(250);
    expect(runResult.sourceNames).toEqual([
      'Large Sim',
      'Credential Isolation Check',
      'Tokenized M3U',
    ]);
    expect(runResult.liveCatCount).toBeGreaterThan(0);
    expect(runResult.movieCatCount).toBeGreaterThan(0);
    expect(runResult.seriesCatCount).toBeGreaterThan(0);
    expect(runResult.firstPageCount).toBe(25);
    expect(runResult.seasonsOk).toBe(true);
    expect(runResult.episodeCount).toBeGreaterThan(0);
    expect(runResult.resolvedLargeUrl).toContain(['', 'live', 'large', 'large', ''].join('/'));
    expect(runResult.resolvedM3u).toEqual({
      url: `http://stream.example/live/${SYNTH_M3U_VAL}/101.ts`,
      headers: {
        referer: `http://ref.example/page?token=${SYNTH_M3U_VAL}`,
        authorization: SYNTH_AUTH_VAL,
      },
    });

    const scanTargets = [
      join(userDataDir, 'catalog.db'),
      join(userDataDir, 'catalog.db-wal'),
      join(userDataDir, 'catalog.db-shm'),
      join(userDataDir, 'secrets.json'),
    ];
    expect(existsSync(join(userDataDir, 'catalog.db'))).toBe(true);
    expect(existsSync(join(userDataDir, 'secrets.json'))).toBe(true);
    expect(statSync(join(userDataDir, 'secrets.json')).size).toBeGreaterThan(20);

    const forbidden = [
      SYNTH_XTREAM_VAL,
      SYNTH_XTREAM_ACCT,
      'panel.example',
      SYNTH_M3U_VAL,
      SYNTH_AUTH_VAL,
      SYNTH_GUIDE_VAL,
    ];

    const assertZeroCredentials = (files: readonly string[]): void => {
      for (const filePath of files) {
        if (!existsSync(filePath)) continue;
        const raw = readFileSync(filePath);
        for (const secret of forbidden) {
          expect(raw.includes(Buffer.from(secret, 'utf8')), `UTF-8 leak in ${filePath}`).toBe(
            false,
          );
          expect(raw.includes(Buffer.from(secret, 'utf16le')), `UTF-16LE leak in ${filePath}`).toBe(
            false,
          );
        }
      }
    };

    // Scan live SQLite + WAL + SHM + secrets.json while utilityProcess holds catalog.db open
    assertZeroCredentials(scanTargets);

    await app.close();

    // Scan all catalog & secret files again after clean before-quit SQLite shutdown
    assertZeroCredentials(scanTargets);
    assertZeroCredentials(
      collectFiles(userDataDir).filter(
        (f) => f.includes('catalog.db') || f.endsWith('secrets.json'),
      ),
    );
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('recovers transparently when the catalog utilityProcess crashes', async () => {
  hangRequested = false;
  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-catalog-crash-'));
  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`, ...cipherLaunchArgs()],
  });

  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('ELV IPTV');

    const hangingId = await page.evaluate(async (m3uUrl) => {
      const catalog = (globalThis as unknown as { elv?: { catalog: CatalogBridge } }).elv?.catalog;
      if (!catalog) throw new Error('missing catalog bridge');
      const opened = await catalog.open();
      if (!opened.ok) throw new Error('open failed');
      const added = await catalog.addSource({
        kind: 'm3u',
        name: 'Crash Survivor',
        playlistUrl: `${m3uUrl}/playlist.m3u`,
      });
      if (!added.ok) throw new Error('addSource failed');
      const hanging = await catalog.addSource({
        kind: 'm3u',
        name: 'In-Flight During Crash',
        playlistUrl: `${m3uUrl}/hang.m3u`,
      });
      if (!hanging.ok) throw new Error('addSource hanging failed');
      return hanging.value.id;
    }, m3uBaseUrl);

    const firstPid = await app.evaluate(
      ({ app: electronApp }) =>
        electronApp
          .getAppMetrics()
          .find(
            (m) =>
              m.type === 'Utility' &&
              (m.name === 'ELV Catalog' ||
                m.serviceName === 'ELV Catalog' ||
                m.serviceName === 'node.mojom.NodeService'),
          )?.pid,
    );
    expect(typeof firstPid).toBe('number');

    // Start an in-flight import so we prove crash settlement (`storage/worker-exited`) before reconnecting
    const inFlightImport = page.evaluate((id) => {
      const catalog = (globalThis as unknown as { elv?: { catalog: CatalogBridge } }).elv?.catalog;
      if (!catalog) throw new Error('missing catalog bridge');
      return catalog.startImport(id).result;
    }, hangingId);

    await expect.poll(() => hangRequested).toBe(true);

    // Kill the catalog utility process abruptly
    process.kill(firstPid as number);

    // Awaiting inFlightImport guarantees `catalog:disconnected` has arrived and dropped the stale port in preload
    expect(await inFlightImport).toEqual({
      ok: false,
      error: { category: 'storage', code: 'worker-exited' },
    });

    // Next renderer call transparently respawns a new utilityProcess and reads persisted SQLite state
    const names = await page.evaluate(async () => {
      const catalog = (globalThis as unknown as { elv?: { catalog: CatalogBridge } }).elv?.catalog;
      const sources = await catalog?.listSources();
      return sources?.map((s) => s.name) ?? [];
    });
    expect(names).toEqual(['Crash Survivor', 'In-Flight During Crash']);

    const respawnedPid = await app.evaluate(
      ({ app: electronApp }) =>
        electronApp
          .getAppMetrics()
          .find(
            (m) =>
              m.type === 'Utility' &&
              (m.name === 'ELV Catalog' ||
                m.serviceName === 'ELV Catalog' ||
                m.serviceName === 'node.mojom.NodeService'),
          )?.pid,
    );
    expect(typeof respawnedPid).toBe('number');
    expect(respawnedPid).not.toBe(firstPid);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('fails closed on headless Linux when safeStorage falls back to basic_text', async () => {
  if (process.platform !== 'linux') {
    test.skip(true, 'Linux basic_text backend check applies only to Linux');
    return;
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'elv-e2e-catalog-linux-lock-'));
  const app = await electron.launch({
    args: [DESKTOP_ROOT, '--password-store=basic', `--user-data-dir=${userDataDir}`],
  });

  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('ELV IPTV');

    const backend = await app.evaluate(({ safeStorage }) =>
      typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : 'unknown',
    );
    if (backend !== 'basic_text' && backend !== 'unknown') {
      test.skip(true, `Linux desktop keyring active (${backend}); not basic_text`);
      return;
    }

    const res = await page.evaluate(async () => {
      const catalog = (globalThis as unknown as { elv?: { catalog: CatalogBridge } }).elv?.catalog;
      if (!catalog) throw new Error('missing catalog bridge');
      await catalog.open();
      return catalog.addSource({
        kind: 'm3u',
        name: 'Must Fail Closed',
        playlistUrl: 'http://list.example/a.m3u',
      });
    });

    expect(res).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-store-failed' },
    });
    expect(existsSync(join(userDataDir, 'secrets.json'))).toBe(false);
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

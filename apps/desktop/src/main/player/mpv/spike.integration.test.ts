import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mpvRuntimePaths } from '../runtime-path.ts';
import { SIM_URL, simLiveUrl, simMovieUrl, simulatorAnswers } from '../testing/sim-streams.ts';
import type { MpvEvent } from './codec.ts';
import type { MpvProcess } from './process.ts';
import { spawnMpv } from './process.ts';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = mpvRuntimePaths({
  isPackaged: false,
  resourcesPath: '',
  appPath: resolve(here, '../../../..'),
  platform: process.platform,
  arch: process.arch,
});
const fixtureDir =
  process.platform === 'darwin' ? resolve(here, 'fixtures/darwin') : resolve(here, 'fixtures');
const record = process.env['ELV_RECORD_MPV_FIXTURES'] === '1';
// Opt-in: it opens mpv windows and takes about 30 s. Recording implies it.
const optedIn = process.env['ELV_MPV_SPIKE'] === '1' || record;
const ready = optedIn && runtime !== null && (await simulatorAnswers());

/** Launcher arguments for a hidden-ish test window; the OSC stays on. */
const TEST_ARGS = [
  '--no-config',
  '--idle=yes',
  '--force-window=immediate',
  '--keep-open=no',
  '--ytdl=no',
  '--load-scripts=no',
  '--terminal=no',
  '--ao=null',
  '--network-timeout=10',
  ...(process.platform === 'darwin' ? [] : ['--curl-enabled=no']),
  '--geometry=320x180+20+20',
  '--no-input-default-bindings',
];

async function launch(): Promise<MpvProcess> {
  return spawnMpv({
    executable: runtime?.executable ?? '',
    args: TEST_ARGS,
    platform: process.platform,
    parentPid: process.pid,
  });
}

// The simulator redaction applied to recorded text: the password path segment of a stream URL becomes three asterisks.
function redactUrls(text: string): string {
  return text.replace(/\/(live|movie|series)\/([^/\s]+)\/[^/\s]+\//g, '/$1/$2/***/');
}

interface Run {
  logs: MpvEvent[];
  endFile: MpvEvent | undefined;
}

interface SimEntry {
  t: string;
  path: string;
  status?: number;
  openConnections?: number;
  headers?: Record<string, string>;
}

async function playUntilEnd(mpv: MpvProcess, url: string, timeoutMs: number): Promise<Run> {
  const logs: MpvEvent[] = [];
  let endFile: MpvEvent | undefined;
  const done = new Promise<void>((resolveDone) => {
    mpv.client.onEvent((e) => {
      if (e.event === 'log-message') logs.push(e);
      if (e.event === 'end-file') {
        endFile = e;
        resolveDone();
      }
    });
    setTimeout(resolveDone, timeoutMs);
  });
  await mpv.client.command(['request_log_messages', 'v']);
  await mpv.client.command(['loadfile', url, 'replace', -1, {}]);
  await done;
  return { logs, endFile };
}

const FAULTS: Record<
  string,
  {
    fault?: string;
    url?: () => Promise<string>;
    signature: RegExp;
    timeoutMs: number;
    reason?: string;
    fileError?: string;
  }
> = {
  '404': { fault: 'status=404', signature: /HTTP error 404 Not Found/, timeoutMs: 15000 },
  '509': { fault: 'status=509', signature: /HTTP error 509/, timeoutMs: 15000 },
  '403': { fault: 'status=403', signature: /HTTP error 403/, timeoutMs: 15000 },
  notice: {
    fault: 'text-notice',
    signature: /Mime-type: 'text\/plain'/,
    fileError: 'unrecognized file format',
    timeoutMs: 15000,
  },
  drop5: { fault: 'drop@5s', signature: /EOF reached/, reason: 'eof', timeoutMs: 40000 },
  refused: {
    signature: /tcp: Connection to tcp:\/\/127\.0\.0\.1:\d+ failed/,
    timeoutMs: 15000,
    url: async () => {
      const server = createServer();
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 1;
      await new Promise<void>((r) => server.close(() => r()));
      return `http://127.0.0.1:${port}/live/demo/demo/1001.ts`;
    },
  },
};

function fixtureLines(run: Run): string[] {
  // Video, audio-output and OSD lines name this machine's GPU and displays and are never parsed.
  const kept = run.logs.filter(
    (e) => !/^(vo|ao|osd|libmpv_render|cocoacb|mac)(\/|$)/.test(String(e['prefix'])),
  );
  const lines = kept.map((e) =>
    JSON.stringify({
      event: 'log-message',
      prefix: String(e['prefix']),
      level: String(e['level']),
      text: redactUrls(String(e['text'])).trimEnd(),
    }),
  );
  if (run.endFile) {
    const {
      event,
      reason,
      file_error: fileError,
      playlist_entry_id: entry,
    } = run.endFile as Record<string, unknown>;
    lines.push(JSON.stringify({ event, reason, file_error: fileError, playlist_entry_id: entry }));
  }
  return lines;
}

async function simRequests(since: string): Promise<SimEntry[]> {
  const res = await fetch(`${SIM_URL}/_sim/requests`);
  return ((await res.json()) as SimEntry[]).filter((r) => r.t >= since);
}

describe.skipIf(!ready)('mpv spike against the simulator', { timeout: 120000 }, () => {
  it('the OSC runs', async () => {
    const mpv = await launch();
    try {
      const reply = await mpv.client.command([
        'script-message-to',
        'osc',
        'osc-visibility',
        'always',
      ]);
      expect(reply.error).toBe('success');
    } finally {
      await mpv.quit();
    }
  });

  it.runIf(process.platform === 'darwin')("quits when the app's end of fd 3 closes", async () => {
    const mpv = await launch();
    const ver = await mpv.client.command(['get_property', 'mpv-version']);
    expect(ver.error).toBe('success');
    const closedAt = Date.now();
    mpv.client.close();
    const exit = await mpv.exited;
    const elapsedMs = Date.now() - closedAt;
    process.stdout.write(`fd3 quit ms: ${elapsedMs}\n`);
    expect(exit.code).toBe(0);
    expect(elapsedMs).toBeLessThanOrEqual(2000);
  });

  it.runIf(process.platform === 'darwin')(
    'plays live video through cocoa-cb without Vulkan',
    async () => {
      const mpv = await launch();
      try {
        await mpv.client.command(['loadfile', simLiveUrl(1001), 'replace', -1, {}]);
        const deadline = Date.now() + 8000;
        let playbackTime = 0;
        while (Date.now() < deadline && playbackTime < 0.5) {
          await new Promise((r) => setTimeout(r, 250));
          const res = await mpv.client.command(['get_property', 'playback-time']);
          if (res.error === 'success' && typeof res.data === 'number') playbackTime = res.data;
        }
        expect(playbackTime).toBeGreaterThanOrEqual(0.5);
        const vo = await mpv.client.command(['get_property', 'current-vo']);
        const configured = await mpv.client.command(['get_property', 'vo-configured']);
        const params = await mpv.client.command(['get_property', 'video-params']);
        expect(vo.data).toBe('libmpv');
        expect(configured.data).toBe(true);
        expect(params.data).toMatchObject({ w: 1280, h: 720 });
      } finally {
        await mpv.quit();
      }
    },
  );

  for (const [name, spec] of Object.entries(FAULTS)) {
    it(`records log lines for the ${name} fault`, async () => {
      const mpv = await launch();
      try {
        const url = spec.url ? await spec.url() : simLiveUrl(1001, spec.fault);
        const run = await playUntilEnd(mpv, url, spec.timeoutMs);
        const file = resolve(fixtureDir, `${name}.jsonl`);
        if (record) {
          mkdirSync(fixtureDir, { recursive: true });
          writeFileSync(file, `${fixtureLines(run).join('\n')}\n`);
        }
        const recorded = readFileSync(file, 'utf8');
        for (const m of recorded.matchAll(/\/(?:live|movie|series)\/[^/\s]+\/([^/\s]*)\//g)) {
          expect(m[1]).toBe('***');
        }
        expect(recorded).toMatch(spec.signature);
        expect(fixtureLines(run).join('\n')).toMatch(spec.signature);
        expect(run.endFile?.['reason']).toBe(spec.reason ?? 'error');
        if (spec.fileError) expect(run.endFile?.['file_error']).toBe(spec.fileError);
      } finally {
        await mpv.quit();
      }
    });
  }

  it('a movie loads and reports its duration', async () => {
    const mpv = await launch();
    try {
      await mpv.client.command(['loadfile', simMovieUrl(), 'replace', -1, {}]);
      await new Promise((r) => setTimeout(r, 2500));
      const duration = await mpv.client.command(['get_property', 'duration']);
      expect(duration.error).toBe('success');
      expect(Number(duration.data)).toBeGreaterThan(0);
    } finally {
      await mpv.quit();
    }
  });

  it('a header with a comma arrives intact', async () => {
    const mpv = await launch();
    try {
      const userAgent = 'Mozilla/5.0 (KHTML, like Gecko) ElvSpike/1';
      // Wanted on the wire: `X-Elv-Test: a,b\c`. mpv list syntax: a backslash escapes the separator.
      const commaOnly = 'X-Elv-Test: a\\,b\\c';
      const doubled = 'X-Elv-Test: a\\,b\\\\c';
      const seen: Record<string, string | undefined> = {};
      for (const [label, value] of [
        ['commaOnly', commaOnly],
        ['doubled', doubled],
      ] as const) {
        const since = new Date().toISOString();
        const loaded = await mpv.client.command([
          'loadfile',
          simLiveUrl(1004),
          'replace',
          -1,
          { 'user-agent': userAgent, 'http-header-fields': value },
        ]);
        expect(loaded.error).toBe('success');
        await new Promise((r) => setTimeout(r, 2000));
        await mpv.client.command(['stop']);
        await new Promise((r) => setTimeout(r, 800));
        const hit = (await simRequests(since)).find((r) => r.path.includes('/live/demo/'));
        seen[`${label}-ua`] = hit?.headers?.['user-agent'];
        seen[label] = hit?.headers?.['x-elv-test'];
      }
      process.stdout.write(`header result: ${JSON.stringify(seen)}\n`);
      expect(seen['commaOnly-ua']).toBe(userAgent);
      expect(seen['commaOnly']).toBe('a,b\\c');
    } finally {
      await mpv.quit();
    }
  });

  it('loadfile replace never overlaps on the simulator', async () => {
    const mpv = await launch();
    try {
      const since = new Date().toISOString();
      for (let i = 0; i < 10; i += 1) {
        await mpv.client.command([
          'loadfile',
          simLiveUrl(i % 2 === 0 ? 1001 : 1004),
          'replace',
          -1,
          {},
        ]);
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, 1500));
      const log = (await simRequests(since)).filter((r) => r.path.includes('/live/demo/'));
      expect(log.length).toBeGreaterThan(0);
      expect(log.filter((r) => r.status === 509 || r.status === 403)).toEqual([]);
      expect(Math.max(...log.map((r) => r.openConnections ?? 0))).toBeLessThanOrEqual(1);
    } finally {
      await mpv.quit();
    }
  });
});

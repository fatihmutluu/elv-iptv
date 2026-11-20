import { describe, expect, it } from 'vitest';
import { CORPUS_USAGE, corpusMain } from '../src/gates/corpus-cli.ts';
import {
  buildGateCorpusItems,
  type CorpusLine,
  judgeCorpus,
  parseCorpusLine,
  runCorpusGate,
} from '../src/gates/corpus-gate.ts';
import type { GateDevice } from '../src/gates/gate-device.ts';
import { corpusCatalog } from '../src/sim/corpus.ts';

const logLine = (body: unknown) =>
  `2026-11-15 10:00:05.000 Df ELVIPTV[42:1] ELV_GATE_CORPUS ${JSON.stringify(body)}`;

function fakeDevice(opts: { logs: string[]; simHost?: string; crashes?: string[] }): {
  device: GateDevice;
  events: string[];
  urls: string[];
} {
  const events: string[] = [];
  const urls: string[] = [];
  let reads = 0;
  const device: GateDevice = {
    simHost: opts.simHost ?? '127.0.0.1:7878',
    describe: async () => ({ platform: 'tvos', name: 'Apple TV 4K (3rd generation)' }),
    install: async () => void events.push('install'),
    start: async (url, startOpts) => {
      events.push('start');
      await startOpts?.afterStop?.();
      urls.push(url);
    },
    stop: async () => void events.push('stop'),
    readLog: async () => opts.logs[Math.min(reads++, opts.logs.length - 1)] ?? '',
    crashesSince: async () => opts.crashes ?? [],
    memoryMb: async () => null,
    close: async () => void events.push('close'),
  };
  return { device, events, urls };
}

describe('buildGateCorpusItems', () => {
  it('builds the 29-item manifest matching corpusCatalog(1)', () => {
    const catalog = corpusCatalog(1);
    const items = buildGateCorpusItems({
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      burst: 8,
    });
    expect(items).toHaveLength(29);

    const liveItems = items.slice(0, 14);
    expect(liveItems.map((item) => item.label)).toEqual(catalog.live.map((c) => c.name));
    expect(liveItems[11]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1012.ts?fault=type=text/html,burst=8',
    );
    expect(liveItems[12]?.url).toBe('http://127.0.0.1:7878/demo/demo/1013');
    expect(liveItems[13]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1014.ts?fault=type=application/vnd.apple.mpegurl,burst=8',
    );

    expect(items[14]).toMatchObject({
      id: 'live-1010-hls',
      url: 'http://127.0.0.1:7878/live/demo/demo/1010.m3u8',
      selectSubtitleLang: 'tur',
    });

    const vodItems = items.slice(15, 27);
    expect(vodItems.map((item) => item.label)).toEqual(catalog.movies.map((m) => m.name));
    expect(vodItems.map((item) => item.url)).toEqual(
      catalog.movies.map((m) => `http://127.0.0.1:7878/movie/demo/demo/${m.id}.${m.ext}`),
    );
    expect(vodItems[9]?.selectSubtitleLang).toBe('tur');
    expect(vodItems[10]?.selectSubtitleLang).toBe('tur');

    expect(items[27]).toMatchObject({
      id: 'vod-200010-hls',
      url: 'http://127.0.0.1:7878/movie/demo/demo/200010.m3u8',
      selectSubtitleLang: 'tur',
      seekMs: 30_000,
    });
    expect(items[28]).toMatchObject({
      id: 'vod-200001-empty',
      url: 'http://127.0.0.1:7878/movie/demo/demo/200001.mp4?fault=empty',
      expect: 'failed',
    });
  });
});

describe('parseCorpusLine and judgeCorpus', () => {
  it('parses the last well-formed ELV_GATE_CORPUS line and judges failures, limit responses and crashes', () => {
    const first: CorpusLine = {
      total: 29,
      passed: 28,
      failed: [{ id: 'live-1014', label: 'Stream labelled as a playlist', reason: 'timeout' }],
      surfaceCreated: 1,
      staleEventsApplied: 0,
    };
    const second: CorpusLine = {
      total: 29,
      passed: 29,
      failed: [],
      surfaceCreated: 1,
      staleEventsApplied: 0,
    };
    const text = ['noise', logLine(first), 'ELV_GATE_CORPUS {bad', logLine(second)].join('\n');
    expect(parseCorpusLine(text)).toEqual(second);
    expect(parseCorpusLine('ELV_GATE_CORPUS {"total":"29"}')).toBeUndefined();
    expect(parseCorpusLine('nothing')).toBeUndefined();

    expect(judgeCorpus(second, { limitResponses: 0, overlapMs: 0 }, [])).toEqual({
      ok: true,
      failures: [],
    });
    expect(
      judgeCorpus({ ...first, staleEventsApplied: 1 }, { limitResponses: 2, overlapMs: 120 }, [
        'ELVIPTV-1.ips',
      ]),
    ).toEqual({
      ok: false,
      failures: [
        'live-1014 (Stream labelled as a playlist): timeout',
        'staleEventsApplied: 1 (expected 0)',
        'limitResponses: 2 (expected 0)',
        'overlapMs: 120 (expected 0)',
        'crash reports newer than the run: ELVIPTV-1.ips',
      ],
    });
  });
});

describe('runCorpusGate', () => {
  it('opens elviptv://gate/corpus on a device, checks simulator log limitResponses === 0, and closes', async () => {
    const line: CorpusLine = {
      total: 29,
      passed: 29,
      failed: [],
      surfaceCreated: 1,
      staleEventsApplied: 0,
    };
    const dev = fakeDevice({ logs: ['', logLine(line)] });
    let cleared = 0;
    const out = await runCorpusGate({
      exec: async () => ({ ok: true, output: '' }),
      target: 'tvos',
      burst: 8,
      device: dev.device,
      sim: {
        ensure: async () => ({
          reused: true,
          reset: async () => {
            cleared += 1;
          },
          stop: async () => {},
        }),
      },
      simLog: {
        clear: async () => {
          cleared += 1;
        },
        entries: async () => [],
      },
      ffmpeg: () => null,
      sleep: async () => {},
    });
    expect(dev.urls).toEqual(['elviptv://gate/corpus?host=127.0.0.1:7878&account=corpus&burst=8']);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(out.outcome).toEqual({ ok: true, failures: [] });
    expect(out.connections).toEqual({ limitResponses: 0, overlapMs: 0 });
  });
});

describe('corpusMain', () => {
  it('validates --target and requires --app on Apple targets', async () => {
    const err: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => {
      err.push(t);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await corpusMain({ target: 'bogus' }, '.')).toBe(2);
      expect(await corpusMain({ target: 'tvos' }, '.')).toBe(2);
    } finally {
      process.stderr.write = real;
    }
    expect(err.join('')).toMatch(/--app/);
    expect(CORPUS_USAGE).toMatch(/gate corpus/);
  });
});

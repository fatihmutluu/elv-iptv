import type { EngineEvent, LoadCommand, PlayerEngine } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { render, waitFor } from '@testing-library/react-native';
import { CorpusGateScreen } from '../CorpusGateScreen';
import { buildCorpusItems, parseCorpusGateUrl } from '../corpus-items';

jest.mock('@elv/engine-aether', () => ({
  createAetherEngine: () => null,
  AetherSurface: () => null,
}));

jest.mock('@elv/engine-media3', () => ({
  createMedia3Engine: () => null,
  Media3Surface: () => null,
}));

describe('parseCorpusGateUrl and buildCorpusItems', () => {
  it('parses elviptv://gate/corpus links and builds all 29 corpus items', () => {
    expect(parseCorpusGateUrl(null)).toBeUndefined();
    expect(parseCorpusGateUrl('elviptv://gate/player')).toBeUndefined();
    expect(parseCorpusGateUrl('elviptv://gate/corpus')).toEqual({
      host: '10.0.2.2:7878',
      account: 'corpus',
      burst: 0,
    });
    expect(
      parseCorpusGateUrl('elviptv://gate/corpus?host=127.0.0.1:7878&account=demo&burst=8'),
    ).toEqual({
      host: '127.0.0.1:7878',
      account: 'demo',
      burst: 8,
    });

    const items = buildCorpusItems({ base: 'http://127.0.0.1:7878', account: 'demo', burst: 8 });
    expect(items).toHaveLength(29);
    expect(items[0]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1001.ts?fault=burst=8');
    expect(items[11]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1012.ts?fault=type=text/html,burst=8',
    );
    expect(items[12]?.url).toBe('http://127.0.0.1:7878/demo/demo/1013');
    expect(items[13]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1014.ts?fault=type=application/vnd.apple.mpegurl,burst=8',
    );
    expect(items[14]).toMatchObject({
      id: 'live-1010-hls',
      url: 'http://127.0.0.1:7878/live/demo/demo/1010.m3u8',
      selectSubtitleLang: 'tur',
    });
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

describe('CorpusGateScreen', () => {
  it('sweeps all 29 items, seeks VOD HLS WebVTT, verifies empty-200 fails, and prints ELV_GATE_CORPUS', async () => {
    const lines: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string') lines.push(msg);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string') lines.push(msg);
    });

    const seeks: number[] = [];
    const loads: string[] = [];
    const createEngine = (): PlayerEngine => {
      const base = createFakePlayerEngine({
        scripts: {
          'http://127.0.0.1:7878/movie/demo/demo/200001.mp4?fault=empty': [
            { afterMs: 2, emit: 'error', error: { code: 'network', detail: 'empty media' } },
          ],
        },
        now: () => Date.now(),
        schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        anchorOnPlayPause: true,
      });
      const listeners = new Set<(event: EngineEvent) => void>();
      base.subscribe((event) => {
        for (const listener of [...listeners]) listener(event);
      });
      return {
        ...base,
        load(cmd: LoadCommand) {
          loads.push(cmd.url);
          base.load(cmd);
        },
        seek(attempt: number, positionMs: number) {
          seeks.push(positionMs);
          base.seek(attempt, positionMs);
          for (const listener of [...listeners]) {
            listener({
              attempt,
              type: 'clock',
              anchor: { positionMs, atMs: Date.now(), rate: 1, durationMs: 600_000 },
            });
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          listener({ attempt: 0, type: 'surface', change: 'created' });
          return () => {
            listeners.delete(listener);
          };
        },
      };
    };

    try {
      render(
        <CorpusGateScreen
          params={{ host: '127.0.0.1:7878', account: 'demo', burst: 0 }}
          createEngine={createEngine}
          holdMs={5}
          itemTimeoutMs={500}
        />,
      );

      await waitFor(
        () => {
          expect(lines.some((line) => line.startsWith('ELV_GATE_CORPUS '))).toBe(true);
        },
        { timeout: 15_000 },
      );

      const corpusLines = lines.filter((line) => line.startsWith('ELV_GATE_CORPUS '));
      expect(corpusLines).toHaveLength(1);
      const report = JSON.parse((corpusLines[0] ?? '').slice('ELV_GATE_CORPUS '.length)) as {
        total: number;
        passed: number;
        failed: { id: string; label: string; reason: string }[];
        surfaceCreated: number;
        staleEventsApplied: number;
      };
      expect(report).toEqual({
        total: 29,
        passed: 29,
        failed: [],
        surfaceCreated: 1,
        staleEventsApplied: 0,
      });
      expect(loads).toHaveLength(29);
      expect(seeks).toContain(30_000);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

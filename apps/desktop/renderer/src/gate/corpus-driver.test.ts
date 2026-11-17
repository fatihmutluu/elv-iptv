import type { EngineEvent, LoadCommand, PlayerEngine } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { describe, expect, it } from 'vitest';
import { buildDesktopCorpusItems, corpusLine, createCorpusRun } from './corpus-driver.ts';
import { parseGateParams } from './params.ts';

describe('desktop corpus gate params and items', () => {
  it('parses elv-gate=corpus and builds all 29 items', () => {
    expect(parseGateParams('elv-gate=corpus')).toMatchObject({
      base: 'http://127.0.0.1:7878',
      account: 'corpus',
      corpus: true,
      burst: 0,
    });
    expect(
      parseGateParams('elv-gate=player&corpus=1&base=http://127.0.0.1:7878&account=demo&burst=8'),
    ).toMatchObject({
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      corpus: true,
      burst: 8,
    });
    const items = buildDesktopCorpusItems({
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      burst: 0,
    });
    expect(items).toHaveLength(29);
    expect(items[12]?.url).toBe('http://127.0.0.1:7878/demo/demo/1013');
    expect(items[28]?.url).toBe('http://127.0.0.1:7878/movie/demo/demo/200001.mp4?fault=empty');
  });
});

describe('createCorpusRun', () => {
  it('runs the 29-item sweep, fails if empty-200 ends instead of failing, and formats ELV_GATE_CORPUS', async () => {
    const seeks: number[] = [];
    const makeEngine = (emptyEnds: boolean): PlayerEngine => {
      const base = createFakePlayerEngine({
        scripts: {
          'http://127.0.0.1:7878/movie/demo/demo/200001.mp4?fault=empty': emptyEnds
            ? [{ afterMs: 2, emit: 'state', state: 'ended' }]
            : [{ afterMs: 2, emit: 'error', error: { code: 'network', detail: 'empty-vod-eof' } }],
        },
        now: () => Date.now(),
        schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        anchorOnPlayPause: true,
      });
      const listeners = new Set<(event: EngineEvent) => void>();
      base.subscribe((event) => {
        for (const listener of [...listeners]) listener(event);
      });
      return {
        ...base,
        load: (cmd: LoadCommand) => base.load(cmd),
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

    const runOk = createCorpusRun({
      engine: makeEngine(false),
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      now: () => Date.now(),
      later: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      holdMs: 2,
      itemTimeoutMs: 200,
    });
    const okReport = await runOk.start();
    runOk.dispose();
    expect(okReport).toEqual({
      total: 29,
      passed: 29,
      failed: [],
      surfaceCreated: 1,
      staleEventsApplied: 0,
    });
    expect(seeks).toContain(30_000);
    expect(corpusLine(okReport)).toMatch(/^ELV_GATE_CORPUS \{.*\}$/);

    const runBad = createCorpusRun({
      engine: makeEngine(true),
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      now: () => Date.now(),
      later: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      holdMs: 2,
      itemTimeoutMs: 200,
    });
    const badReport = await runBad.start();
    runBad.dispose();
    expect(badReport.passed).toBe(28);
    expect(badReport.failed).toEqual([
      {
        id: 'vod-200001-empty',
        label: 'Empty 200 VOD response',
        reason: 'expected failed, settled on ended',
      },
    ]);
  });
});

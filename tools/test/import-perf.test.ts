import { importCatalog, importGuide } from '@elv/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import {
  count,
  type Env,
  generatedProgrammes,
  m3uSource,
  measureImport,
  openEnv,
  xtreamSource,
} from './import-sim-helpers.ts';
import { SIM_CLOCK, type Sim, startTestSim } from './sources-sim-helpers.ts';

const large = buildCatalog('large', 1);
let sim: Sim;
let env: Env;
let sourceId: string;
beforeAll(async () => {
  sim = await startTestSim();
  env = await openEnv({ file: true });
  sourceId = await xtreamSource(env, sim, 'large');
});
afterAll(async () => {
  env.close();
  await sim.close();
});

describe('large profile imported into a file database', () => {
  it('imports the 100k-entry catalog within 20 s', async () => {
    const report = await measureImport(
      'large catalog',
      env,
      async (tick) => {
        const result = await importCatalog(sourceId, env.deps, { onProgress: tick });
        if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result.error)}`);
        return result.value.counts;
      },
      ['live', 'movies', 'series'],
    );
    process.stdout.write(`${report.line}\n`);
    expect(await count(env.db, 'live')).toBe(large.live.length);
    expect(await count(env.db, 'movies')).toBe(large.movies.length);
    expect(await count(env.db, 'series')).toBe(large.series.length);
    expect(report.rows).toBe(large.live.length + large.movies.length + large.series.length);
    expect(report.seconds).toBeLessThanOrEqual(20);
  }, 120_000);

  it('imports the 100k-entry playlist as an M3U source within 20 s', async () => {
    const id = await m3uSource(env, sim, 'large');
    const episodes = large.series.reduce((n, s) => n + s.episodes.length, 0);
    const report = await measureImport(
      'large playlist',
      env,
      async (tick) => {
        const result = await importCatalog(id, env.deps, { onProgress: tick });
        if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result.error)}`);
        return result.value.counts;
      },
      ['live', 'movies', 'episodes'],
    );
    process.stdout.write(`${report.line}\n`);
    expect(report.rows).toBe(large.live.length + large.movies.length + episodes);
    expect(await count(env.db, 'live WHERE source_id = ?', [id])).toBe(large.live.length);
    expect(await count(env.db, 'movies WHERE source_id = ?', [id])).toBe(large.movies.length);
    expect(await count(env.db, 'episodes WHERE source_id = ?', [id])).toBe(episodes);
    expect(await count(env.db, 'live WHERE source_id = ? AND url_template IS NULL', [id])).toBe(0);
    expect(report.seconds).toBeLessThanOrEqual(20);
  }, 120_000);

  it('imports the 7-day guide of 5,000 channels within 60 s', async () => {
    const report = await measureImport(
      'large guide',
      env,
      async (tick) => {
        const result = await importGuide(sourceId, env.deps, {
          now: SIM_CLOCK.getTime(),
          onProgress: tick,
        });
        if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result.error)}`);
        expect(result.value.counts.mapped).toBe(5000);
        return result.value.counts;
      },
      ['programmes'],
    );
    process.stdout.write(`${report.line}\n`);
    expect(await count(env.db, 'programmes')).toBe(report.rows);
    expect(report.rows).toBe(generatedProgrammes(large, SIM_CLOCK));
    expect(await count(env.db, 'channel_guide')).toBe(large.guideChannels);
    expect(await count(env.db, 'programmes_next')).toBe(0);
    expect(report.seconds).toBeLessThanOrEqual(60);
  }, 240_000);
});

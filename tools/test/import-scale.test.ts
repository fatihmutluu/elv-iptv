import { importCatalog, importGuide } from '@elv/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import { type Env, measureImport, openEnv, xtreamSource } from './import-sim-helpers.ts';
import { SIM_CLOCK, type Sim, startTestSim } from './sources-sim-helpers.ts';

const enabled = process.env.SIM_HUGE === '1';
if (!enabled) {
  process.stdout.write(
    'import-scale: skipped (set SIM_HUGE=1 to import the 500k-entry huge profile)\n',
  );
}

describe.skipIf(!enabled)('huge profile imported into a file database', () => {
  let sim: Sim;
  let env: Env;
  let sourceId: string;
  const huge = buildCatalog('huge', 1);
  beforeAll(async () => {
    sim = await startTestSim();
    env = await openEnv({ file: true });
    sourceId = await xtreamSource(env, sim, 'huge');
  });
  afterAll(async () => {
    env.close();
    await sim.close();
  });

  it('imports 500k catalog entries', async () => {
    const report = await measureImport(
      'huge catalog',
      env,
      async (tick) => {
        const result = await importCatalog(sourceId, env.deps, { onProgress: tick });
        if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result.error)}`);
        return result.value.counts;
      },
      ['live', 'movies', 'series'],
    );
    process.stdout.write(`${report.line}\n`);
    expect(report.rows).toBe(huge.live.length + huge.movies.length + huge.series.length);
  }, 900_000);

  it('imports the huge guide', async () => {
    const report = await measureImport(
      'huge guide',
      env,
      async (tick) => {
        const result = await importGuide(sourceId, env.deps, {
          now: SIM_CLOCK.getTime(),
          onProgress: tick,
        });
        if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result.error)}`);
        expect(result.value.counts.mapped).toBe(huge.guideChannels);
        return result.value.counts;
      },
      ['programmes'],
    );
    process.stdout.write(`${report.line}\n`);
    expect(report.rows).toBeGreaterThan(huge.guideChannels * 7);
  }, 1_800_000);
});

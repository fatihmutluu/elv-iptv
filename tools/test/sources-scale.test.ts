import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import {
  clientFor,
  type Meter,
  measureScan,
  must,
  type Sim,
  scanGuide,
  scanPlaylist,
  startTestSim,
} from './sources-sim-helpers.ts';

const enabled = process.env.SIM_HUGE === '1';
if (!enabled) {
  process.stdout.write(
    'sources-scale: skipped (set SIM_HUGE=1 to scan the 500k-entry huge profile)\n',
  );
}

describe.skipIf(!enabled)('huge profile over HTTP', () => {
  let sim: Sim;
  beforeAll(async () => {
    buildCatalog('large', 1);
    buildCatalog('huge', 1);
    sim = await startTestSim();
  });
  afterAll(async () => {
    await sim.close();
  });

  it('scans 500k playlist entries as cheaply per entry as 100k', async () => {
    const run = (path: string) => async (meter: Meter) => {
      const scan = await scanPlaylist(`${sim.url}${path}`, {
        keep: false,
        ...(meter ? { meter } : {}),
      });
      return scan.count;
    };
    const large = await measureScan('large playlist', run('/playlists/large.m3u'));
    const huge = await measureScan('huge playlist', run('/playlists/huge.m3u'));
    process.stdout.write(`${large.line}
`);
    process.stdout.write(`${huge.line}
`);
    expect(huge.entries).toBe(500_000);
    expect(huge.heapGrowthMb).toBeLessThanOrEqual(large.heapGrowthMb * 1.25 + 32);
    expect(huge.heapGrowthMb).toBeLessThan(256);
    expect(huge.seconds / huge.entries).toBeLessThanOrEqual((large.seconds / large.entries) * 1.5);
  }, 300_000);

  it('scans the huge guide', async () => {
    const report = await measureScan('huge guide', async (meter) => {
      const scan = await scanGuide(`${sim.url}/guides/huge.xml`, { keep: false, meter });
      expect(scan.failed).toBe(false);
      expect(scan.channels).toHaveLength(20_000);
      return scan.programmeCount;
    });
    process.stdout.write(`${report.line}
`);
    expect(report.entries).toBeGreaterThan(20_000 * 7);
  }, 600_000);

  it('fetches the huge VOD list category by category', async () => {
    const client = clientFor(sim, 'huge');
    const report = await measureScan('huge xtream vod', async () => {
      let total = 0;
      for (const category of must(await client.categories('movie'))) {
        total += must(await client.vodStreams(category.id)).length;
      }
      return total;
    });
    process.stdout.write(`${report.line}
`);
    expect(report.entries).toBe(300_000);
  }, 600_000);
});

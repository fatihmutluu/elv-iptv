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

  it('scans 500k playlist entries with the same live heap as 100k', async () => {
    const run = (path: string) => async (meter: Meter) => {
      const scan = await scanPlaylist(`${sim.url}${path}`, { keep: false, meter });
      expect(scan.failed).toBe(false);
      return scan.count;
    };
    const large = await measureScan('large playlist', run('/playlists/large.m3u'));
    const huge = await measureScan('huge playlist', run('/playlists/huge.m3u'));
    process.stdout.write(`${large.line}
`);
    process.stdout.write(`${huge.line}
`);
    expect(huge.entries).toBe(500_000);
    expect(huge.heapGrowthMb).toBeLessThanOrEqual(large.heapGrowthMb * 1.25);
    expect(huge.seconds / huge.entries).toBeLessThanOrEqual((large.seconds / large.entries) * 1.5);
  }, 300_000);

  it('scans the huge guide with the same live heap as the large one', async () => {
    const run = (path: string, channels: number) => async (meter: Meter) => {
      const scan = await scanGuide(`${sim.url}${path}`, { keep: false, meter });
      expect(scan.failed).toBe(false);
      expect(scan.channelCount).toBe(channels);
      return scan.programmeCount;
    };
    const large = await measureScan('large guide', run('/guides/large.xml', 5000));
    const huge = await measureScan('huge guide', run('/guides/huge.xml', 20_000));
    process.stdout.write(`${large.line}
`);
    process.stdout.write(`${huge.line}
`);
    expect(huge.entries).toBeGreaterThan(20_000 * 7);
    // The HTTP transport itself keeps about 3% of the streamed bytes alive until the next large response
    // (measured without any scanner: +6 MB for 187 MB, +20 MB for 752 MB), so the guide cannot be held to
    // the playlist's 1.25x ratio over HTTP. The bound below only proves the scan does not hold the guide.
    expect(huge.heapGrowthMb).toBeLessThan(64);
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

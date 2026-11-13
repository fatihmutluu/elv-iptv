import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import {
  measureScan,
  type Sim,
  scanGuide,
  scanPlaylist,
  startTestSim,
} from './sources-sim-helpers.ts';

let sim: Sim;
beforeAll(async () => {
  buildCatalog('large', 1);
  sim = await startTestSim();
});
afterAll(async () => {
  await sim.close();
});

describe('large profile over HTTP', () => {
  it('scans 100k playlist entries within 5 s and 200 MB of heap', async () => {
    const report = await measureScan('large playlist', async (meter) => {
      const scan = await scanPlaylist(`${sim.url}/playlists/large.m3u`, { keep: false, meter });
      expect(scan.stats?.warnings).toEqual([]);
      return scan.count;
    });
    process.stdout.write(`${report.line}
`);
    expect(report.entries).toBe(100_000);
    expect(report.seconds * 1000).toBeLessThanOrEqual(5000);
    expect(report.heapGrowthMb).toBeLessThan(200);
  }, 60_000);

  it('scans the large guide within 30 s', async () => {
    const report = await measureScan('large guide', async (meter) => {
      const scan = await scanGuide(`${sim.url}/guides/large.xml`, { keep: false, meter });
      expect(scan.failed).toBe(false);
      expect(scan.channels).toHaveLength(5000);
      return scan.programmeCount;
    });
    process.stdout.write(`${report.line}
`);
    expect(report.entries).toBeGreaterThan(5000);
    expect(report.seconds * 1000).toBeLessThanOrEqual(30_000);
  }, 120_000);
});

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findHermesCli, findHermesc, runHermesSources } from '../bin/hermes/runner.ts';
import { findRepoRoot } from '../src/root.ts';

const root = findRepoRoot(process.cwd());

describe('Hermes source scanner verification (#37)', () => {
  it('locates the bundled hermesc compiler binary', () => {
    const hermesc = findHermesc(root);
    expect(existsSync(hermesc)).toBe(true);
  });

  it('bundles @elv/sources and compiles cleanly to Hermes bytecode via hermesc', async () => {
    const report = await runHermesSources({
      root,
      benchmark: 'small',
      requireRuntime: false,
    });

    expect(report.compiledBytes).toBeGreaterThan(10_000);

    const hermesCli = findHermesCli();
    if (hermesCli !== undefined) {
      expect(report.executed).toBe(true);
      expect(report.result?.runtime).toBe('hermes');
      expect(report.result?.polyfillsNeeded).toEqual(['Symbol.asyncIterator']);
      expect(report.result?.assertionsPassed).toBeGreaterThanOrEqual(10);
      expect(report.result?.m3u.entries).toBe(110);
      expect(report.result?.m3u.mbPerSec).toBeGreaterThan(0);
      expect(report.result?.xmltv.programmes).toBeGreaterThan(1_000);
      expect(report.result?.xmltv.mbPerSec).toBeGreaterThan(0);
    }
  }, 60_000);

  it('fails when requireRuntime is true and the explicit hermes binary path is missing', async () => {
    await expect(
      runHermesSources({
        root,
        benchmark: 'small',
        requireRuntime: true,
        hermesBin: '/nonexistent/hermes-binary',
      }),
    ).rejects.toThrow(/hermes/i);
  });
});

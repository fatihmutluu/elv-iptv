import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { versionAtLeast } from '../src/bootstrap.ts';
import { findRepoRoot } from '../src/root.ts';
import { type Check, formatReport, runChecks } from '../src/runner.ts';

const pass = (key: string): Check => ({ key, run: async () => ({ ok: true, output: '' }) });
const fail = (key: string, output: string): Check => ({
  key,
  run: async () => ({ ok: false, output }),
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runChecks', () => {
  it('runs every check and counts passes and failures', async () => {
    const report = await runChecks([pass('a'), fail('b', 'boom'), pass('c')]);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.results.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('runs a single check with only', async () => {
    const report = await runChecks([pass('a'), fail('b', 'x')], { only: 'a' });
    expect(report.results.map((r) => r.key)).toEqual(['a']);
    expect(report.failed).toBe(0);
  });

  it('fails on an unknown only key', async () => {
    const report = await runChecks([pass('a')], { only: 'zzz' });
    expect(report.failed).toBe(1);
    expect(report.results[0]?.output).toContain('zzz');
  });

  it('turns a throwing check into a failure', async () => {
    const throwing: Check = {
      key: 't',
      run: async () => {
        throw new Error('exploded');
      },
    };
    const report = await runChecks([throwing]);
    expect(report.failed).toBe(1);
    expect(report.results[0]?.output).toContain('exploded');
  });
});

describe('formatReport', () => {
  it('prints failures and the summary line only', async () => {
    const report = await runChecks([pass('a'), fail('b', 'boom\n')]);
    const text = formatReport(report);
    expect(text).toContain('FAIL b');
    expect(text).toContain('boom');
    expect(text).not.toContain('a\n');
    expect(text.trimEnd().split('\n').at(-1)).toBe('check: 1 passed, 1 failed');
  });

  it('prints just the summary when everything passes', async () => {
    const text = formatReport(await runChecks([pass('a')]));
    expect(text).toBe('check: 1 passed, 0 failed\n');
  });
});

describe('findRepoRoot', () => {
  it('walks up to the folder holding pnpm-workspace.yaml', () => {
    const root = mkdtempSync(join(tmpdir(), 'elv_root_'));
    dirs.push(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });

  it('throws outside a workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv_noroot_'));
    dirs.push(dir);
    expect(() => findRepoRoot(dir)).toThrow(/pnpm-workspace/);
  });
});

describe('versionAtLeast', () => {
  it('compares dotted versions numerically', () => {
    expect(versionAtLeast('24.22.3', '24.0.0')).toBe(true);
    expect(versionAtLeast('v12.18.0', '12.18.0')).toBe(true);
    expect(versionAtLeast('12.9.0', '12.18.0')).toBe(false);
    expect(versionAtLeast('22.1.0', '24.0.0')).toBe(false);
  });
});

describe('formatReport notes', () => {
  it('prints warnings and skips of passing checks before the summary', async () => {
    const noisy: Check = {
      key: 'file-size',
      run: async () => ({
        ok: true,
        output: '',
        notes: ['warn: a.ts: 450 lines (soft limit 400)'],
      }),
    };
    const skipped: Check = {
      key: 'gitleaks-rules',
      run: async () => ({
        ok: true,
        output: '',
        notes: ['skip gitleaks-rules: gitleaks is not on PATH'],
      }),
    };
    const text = formatReport(await runChecks([noisy, skipped]));
    expect(text).toBe(
      'warn: a.ts: 450 lines (soft limit 400)\n' +
        'skip gitleaks-rules: gitleaks is not on PATH\n' +
        'check: 2 passed, 0 failed\n',
    );
  });
});

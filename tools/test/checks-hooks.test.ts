import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChecks } from '../src/checks.ts';
import { findRepoRoot } from '../src/root.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv_checks_hooks_'));
  tempDirs.push(dir);
  return dir;
}

describe('hooks check discovery', () => {
  it('discovers and runs hook test files under .agents/hooks as well as .claude/hooks', async () => {
    const root = makeTempRoot();
    mkdirSync(join(root, '.agents', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'hooks', 'sample.test.mjs'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails intentionally', () => { assert.equal(1, 2); });\n",
    );

    const hooksCheck = buildChecks(root).find((c) => c.key === 'hooks');
    if (!hooksCheck) throw new Error('missing hooks check');
    const res = await hooksCheck.run();
    expect(res.ok).toBe(false);
    expect(res.output).toContain('fails intentionally');
  });
});

describe('workspace manifest licenses', () => {
  it('declares GPL-3.0-only in the root manifest and every workspace package.json', () => {
    const repoRoot = findRepoRoot(import.meta.dirname);
    const manifests: string[] = ['package.json', 'tools/package.json'];
    for (const group of ['apps', 'packages', 'modules']) {
      const groupDir = join(repoRoot, group);
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgJson = join(groupDir, entry.name, 'package.json');
        try {
          readFileSync(pkgJson, 'utf8');
          manifests.push(`${group}/${entry.name}/package.json`);
        } catch {
          // placeholder folders (vega, tizen, webos) have README.md only
        }
        const rendererJson = join(groupDir, entry.name, 'renderer', 'package.json');
        try {
          readFileSync(rendererJson, 'utf8');
          manifests.push(`${group}/${entry.name}/renderer/package.json`);
        } catch {
          // only apps/desktop has a nested renderer package
        }
      }
    }

    for (const rel of manifests) {
      const parsed = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as { license?: string };
      expect(parsed.license, `${rel} must declare GPL-3.0-only`).toBe('GPL-3.0-only');
    }
  });
});

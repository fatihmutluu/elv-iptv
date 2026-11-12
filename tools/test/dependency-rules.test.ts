import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const config = resolve(here, '..', '..', '.dependency-cruiser.cjs');
const bin = resolve(
  here,
  '..',
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

function cruise(fixture: string): Violation[] {
  const cwd = join(here, 'fixtures', fixture);
  const r = spawnSync(
    process.execPath,
    [bin, '--config', config, '--output-type', 'json', '--no-cache', '.'],
    { cwd, encoding: 'utf8' },
  );
  const report = JSON.parse(r.stdout) as { summary: { violations: Violation[] } };
  return report.summary.violations.filter((v) => v.rule.name !== 'not-resolvable');
}

const ruleNames = (fixture: string) => cruise(fixture).map((v) => v.rule.name);

describe('dependency-cruiser rules', () => {
  it('accepts a correctly layered workspace', () => {
    expect(cruise('valid')).toEqual([]);
  });

  it('rejects react-native imported by a pure package', () => {
    expect(ruleNames('pure-imports-react-native')).toContain('pure-packages-no-platform');
  });

  it('rejects node:fs imported by a pure package', () => {
    expect(ruleNames('pure-imports-node-fs')).toContain('pure-packages-no-node-builtins');
  });

  it('rejects a feature importing another feature', () => {
    expect(ruleNames('feature-to-feature')).toContain('no-feature-to-feature');
  });

  it('rejects features importing modules', () => {
    expect(ruleNames('features-import-modules')).toContain('features-no-modules-or-apps');
  });

  it('rejects domain importing another package', () => {
    expect(ruleNames('domain-imports-sources')).toContain('domain-imports-nothing');
  });

  it('rejects a native module importing features', () => {
    expect(ruleNames('module-imports-features')).toContain('modules-import-playback-only');
  });

  it('rejects a package importing an app', () => {
    expect(ruleNames('package-imports-app')).toContain('workspace-never-imports-apps');
  });
});

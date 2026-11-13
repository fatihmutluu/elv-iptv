import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cruise as cruiseDir } from './cruise.ts';

const here = dirname(fileURLToPath(import.meta.url));

const cruise = (fixture: string) =>
  cruiseDir(join(here, 'fixtures', fixture)).filter((v) => v.rule.name !== 'not-resolvable');

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

  it('lets a feature import the shared ports and shared folders and root-level files', () => {
    expect(cruise('features-shared-folders')).toEqual([]);
  });

  it('rejects a shared folder importing a feature', () => {
    expect(ruleNames('shared-folder-imports-feature')).toContain('no-feature-to-feature');
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

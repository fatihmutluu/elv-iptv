import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/root.ts';

interface Rule {
  name: string;
  from: { path?: string | string[]; pathNot?: string | string[] };
}

const repoRoot = findRepoRoot(import.meta.dirname);
const rules = (
  createRequire(import.meta.url)(join(repoRoot, '.dependency-cruiser.cjs')) as {
    forbidden: Rule[];
  }
).forbidden;

/** Folders without source code; no dependency rule needs to govern them. */
const UNGOVERNED = ['packages/config'];

const list = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const applies = (rule: Rule, file: string) =>
  list(rule.from.path).some((p) => new RegExp(p).test(file)) &&
  !list(rule.from.pathNot).some((p) => new RegExp(p).test(file));

/** Names of the rules written for `folder`, as opposed to rules that cover any package. */
function rulesNaming(folder: string): string[] {
  const probe = 'packages/zz-unlisted-probe/src/index.ts';
  return rules
    .filter((r) => applies(r, `${folder}/src/index.ts`) && !applies(r, probe))
    .map((r) => r.name);
}

const folders = ['packages', 'modules'].flatMap((group) =>
  existsSync(join(repoRoot, group))
    ? readdirSync(join(repoRoot, group), { withFileTypes: true })
        .map((d) => `${group}/${d.name}`)
        .filter((f) => existsSync(join(repoRoot, f, 'package.json')))
    : [],
);

describe('dependency rule coverage', () => {
  it.each(folders.filter((f) => !UNGOVERNED.includes(f)))('a rule governs %s', (folder) => {
    expect(rulesNaming(folder)).not.toEqual([]);
  });

  it('reports a package folder that no rule names', () => {
    expect(rulesNaming('packages/widgets')).toEqual([]);
  });

  it('treats native modules as governed by the modules rule', () => {
    expect(rulesNaming('modules/engine-x')).toContain('modules-import-playback-only');
  });

  it('keeps only existing folders without sources on the ungoverned list', () => {
    for (const folder of UNGOVERNED) {
      expect(existsSync(join(repoRoot, folder))).toBe(true);
      expect(existsSync(join(repoRoot, folder, 'src'))).toBe(false);
    }
  });

  it('restricts imports in Biome for exactly the packages the pure rule names', () => {
    const pure = rules.find((r) => r.name === 'pure-packages-no-platform');
    const expected = folders.filter((f) => pure && applies(pure, `${f}/src/index.ts`));
    const biome = JSON.parse(readFileSync(join(repoRoot, 'biome.json'), 'utf8')) as {
      overrides: { includes: string[]; linter?: { rules?: { style?: object } } }[];
    };
    const override = biome.overrides.find(
      (o) => o.linter?.rules?.style && 'noRestrictedImports' in o.linter.rules.style,
    );
    const listed = (override?.includes ?? []).map((glob) => glob.replace(/\/\*\*$/, ''));
    expect(listed.sort()).toEqual(expected.sort());
  });
});

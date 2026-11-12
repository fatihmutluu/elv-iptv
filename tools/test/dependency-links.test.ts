import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cruise } from './cruise.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(root: string, file: string, content: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

/** A workspace package whose `exports` point at src/index.ts, like the real packages. */
function pkg(root: string, folder: string, name: string, indexSource: string) {
  put(root, `${folder}/package.json`, JSON.stringify({ name, exports: { '.': './src/index.ts' } }));
  put(root, `${folder}/src/index.ts`, indexSource);
}

/** Links `target` into `consumer/node_modules/<name>` the way pnpm does (directory link). */
function link(root: string, consumer: string, name: string, target: string) {
  const at = join(root, consumer, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(join(root, target), at, 'junction');
}

/** Installs a third-party package in the pnpm virtual store and links it into `consumer`. */
function thirdParty(root: string, consumer: string, name: string) {
  const store = `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`;
  put(root, `${store}/package.json`, JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  put(root, `${store}/index.js`, 'module.exports = {};');
  link(root, consumer, name, store);
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'elv_linked_'));
  dirs.push(root);
  return root;
}

const names = (root: string) =>
  cruise(root).map((v) => `${v.rule.name}: ${v.from.split('\\').join('/')}`);

describe('dependency rules over pnpm-style linked workspaces', () => {
  it('resolves @elv/* imports through links to real folders without violations', () => {
    const root = workspace();
    pkg(root, 'packages/domain', '@elv/domain', 'export const id = 1;');
    pkg(
      root,
      'packages/sources',
      '@elv/sources',
      "import { id } from '@elv/domain';\nexport const s = id;",
    );
    link(root, 'packages/sources', '@elv/domain', 'packages/domain');
    expect(cruise(root)).toEqual([]);
  });

  it('catches a pure package importing react-native from the pnpm store', () => {
    const root = workspace();
    pkg(root, 'packages/domain', '@elv/domain', 'export const id = 1;');
    pkg(
      root,
      'packages/sources',
      '@elv/sources',
      "import rn from 'react-native';\nimport { id } from '@elv/domain';\nexport const s = [rn, id];",
    );
    link(root, 'packages/sources', '@elv/domain', 'packages/domain');
    thirdParty(root, 'packages/sources', 'react-native');
    expect(names(root)).toEqual([expect.stringContaining('pure-packages-no-platform: packages')]);
  });

  it('catches a feature importing a native module through its package name', () => {
    const root = workspace();
    pkg(root, 'modules/engine-x', '@elv/engine-x', 'export const e = 1;');
    pkg(
      root,
      'packages/features',
      '@elv/features',
      "import { e } from '@elv/engine-x';\nexport const f = e;",
    );
    link(root, 'packages/features', '@elv/engine-x', 'modules/engine-x');
    expect(names(root)).toEqual([expect.stringContaining('features-no-modules-or-apps: packages')]);
  });
});

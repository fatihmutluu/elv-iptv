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
function pkg(
  root: string,
  folder: string,
  name: string,
  indexSource: string,
  manifest: Record<string, unknown> = {},
) {
  put(
    root,
    `${folder}/package.json`,
    JSON.stringify({ name, exports: { '.': './src/index.ts' }, ...manifest }),
  );
  put(root, `${folder}/src/index.ts`, indexSource);
}

/** Links `target` into `consumer/node_modules/<name>` the way pnpm does (directory link). */
function link(root: string, consumer: string, name: string, target: string) {
  const at = join(root, consumer, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(join(root, target), at, 'junction');
}

/**
 * Installs `realName` in the pnpm virtual store and links it into `consumer` as `name`.
 * A different `realName` reproduces an alias such as `react-native` -> `react-native-tvos`.
 */
function thirdParty(root: string, consumer: string, name: string, realName = name) {
  const store = `node_modules/.pnpm/${realName.replace('/', '+')}@1.0.0/node_modules/${realName}`;
  put(
    root,
    `${store}/package.json`,
    JSON.stringify({ name: realName, version: '1.0.0', main: 'index.js' }),
  );
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

  it('catches a declared react-native that resolves to the react-native-tvos alias', () => {
    const root = workspace();
    pkg(
      root,
      'packages/sources',
      '@elv/sources',
      "import rn from 'react-native';\nexport const s = rn;",
      { dependencies: { 'react-native': 'npm:react-native-tvos@1.0.0' } },
    );
    thirdParty(root, 'packages/sources', 'react-native', 'react-native-tvos');
    expect(names(root)).toEqual([expect.stringContaining('pure-packages-no-platform: packages')]);
  });

  it.each([
    'react-dom',
    'react-native-mmkv',
    '@react-native/assets-registry',
    '@react-native-community/netinfo',
    'expo',
    'expo-sqlite',
    '@expo/vector-icons',
    'electron',
  ])('catches a pure package importing a declared %s', (lib) => {
    const root = workspace();
    pkg(root, 'packages/data', '@elv/data', `import x from '${lib}';\nexport const d = x;`, {
      dependencies: { [lib]: '1.0.0' },
    });
    thirdParty(root, 'packages/data', lib);
    expect(names(root)).toEqual([expect.stringContaining('pure-packages-no-platform: packages')]);
  });

  it('catches a feature importing a scoped expo package', () => {
    const root = workspace();
    pkg(
      root,
      'packages/features',
      '@elv/features',
      "import icons from '@expo/vector-icons';\nexport const f = icons;",
      { dependencies: { '@expo/vector-icons': '1.0.0' } },
    );
    thirdParty(root, 'packages/features', '@expo/vector-icons');
    expect(names(root)).toEqual([expect.stringContaining('features-no-modules-or-apps: packages')]);
  });

  it('accepts react and react-native declared as peer and dev dependencies of a UI package', () => {
    const root = workspace();
    pkg(
      root,
      'packages/ui-kit',
      '@elv/ui-kit',
      "import r from 'react';\nimport rn from 'react-native';\nexport const u = [r, rn];",
      {
        peerDependencies: { react: '*', 'react-native': '*' },
        devDependencies: { react: '1.0.0', 'react-native': 'npm:react-native-tvos@1.0.0' },
      },
    );
    thirdParty(root, 'packages/ui-kit', 'react');
    thirdParty(root, 'packages/ui-kit', 'react-native', 'react-native-tvos');
    expect(names(root)).toEqual([]);
  });

  it('still rejects a dev-only dependency imported from shipped sources', () => {
    const root = workspace();
    pkg(root, 'packages/ui-kit', '@elv/ui-kit', "import t from 'tooling';\nexport const u = t;", {
      devDependencies: { tooling: '1.0.0' },
    });
    thirdParty(root, 'packages/ui-kit', 'tooling');
    expect(names(root)).toEqual([expect.stringContaining('no-dev-dependencies-in-src: packages')]);
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

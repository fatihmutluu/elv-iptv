import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/root.ts';

const repoRoot = findRepoRoot(import.meta.dirname);
const biome = join(repoRoot, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

const PURE = ['domain', 'sources', 'data', 'playback', 'focus-core'];
const FORBIDDEN = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-native',
  'react-native-tvos',
  'react-native-mmkv',
  '@react-native/assets-registry',
  '@react-native-tvos/config-tv',
  'expo',
  'expo/config',
  'expo-sqlite',
  '@expo/vector-icons',
  'electron',
  'node:fs',
  'node:fs/promises',
];
const GLOBALS = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location'];
const ALLOWED = ['@elv/domain', './local', 'exponential-backoff', 'reactive', 'electronic'];

/** Probe file path -> import specifier, linted in one Biome run over a temporary workspace. */
const probes = new Map<string, string>();
let flagged = new Set<string>();
let flaggedGlobals = new Set<string>();
let workspace = '';

function probeGlobal(folder: string, name: string) {
  const file = `${folder}/src/global-${name}.ts`;
  mkdirSync(dirname(join(workspace, file)), { recursive: true });
  writeFileSync(
    join(workspace, file),
    `export const g = ${name};
`,
  );
  return file;
}

function probe(folder: string, specifier: string) {
  const file = `${folder}/src/probe-${probes.size}.ts`;
  probes.set(file, specifier);
  mkdirSync(dirname(join(workspace, file)), { recursive: true });
  writeFileSync(join(workspace, file), `import x from '${specifier}';\n\nexport const p = x;\n`);
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'elv_biome_'));
  writeFileSync(
    join(workspace, 'biome.json'),
    JSON.stringify({
      extends: [join(repoRoot, 'biome.json').replaceAll('\\', '/')],
      vcs: { enabled: false },
    }),
  );
  for (const pkg of PURE) {
    for (const specifier of [...FORBIDDEN, ...ALLOWED]) probe(`packages/${pkg}`, specifier);
  }
  for (const specifier of ['react', 'react-native']) probe('packages/ui-kit', specifier);
  for (const pkg of PURE) for (const name of GLOBALS) probeGlobal(`packages/${pkg}`, name);
  for (const name of GLOBALS) probeGlobal('packages/ui-kit', name);

  const r = spawnSync(
    process.execPath,
    [biome, 'lint', '--colors=off', '--reporter=json', '--max-diagnostics=none', '.'],
    { cwd: workspace, encoding: 'utf8' },
  );
  // Biome marks its JSON reporter experimental; the exact Biome version is pinned.
  const report = JSON.parse(r.stdout) as {
    diagnostics: { category?: string; location?: { path?: string } }[];
  };
  const pathOf = (d: { location?: { path?: string } }) =>
    (d.location?.path ?? '').split('\\').join('/');
  flaggedGlobals = new Set(
    report.diagnostics.filter((d) => d.category === 'lint/style/noRestrictedGlobals').map(pathOf),
  );
  flagged = new Set(
    report.diagnostics
      .filter((d) => d.category === 'lint/style/noRestrictedImports')
      .map((d) => (d.location?.path ?? '').split('\\').join('/')),
  );
}, 60_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const flaggedSpecifiers = (folder: string) =>
  [...probes]
    .filter(([file]) => file.startsWith(`${folder}/`))
    .filter(([file]) => flagged.has(file))
    .map(([, specifier]) => specifier);

describe('Biome restricted imports for pure packages', () => {
  it.each(PURE)('flags every platform import in packages/%s and nothing else', (pkg) => {
    expect(flaggedSpecifiers(`packages/${pkg}`)).toEqual(FORBIDDEN);
  });

  it('leaves UI packages free to import react and react-native', () => {
    expect(flaggedSpecifiers('packages/ui-kit')).toEqual([]);
  });

  it.each(PURE)('flags browser globals in packages/%s', (pkg) => {
    const files = GLOBALS.map((name) => `packages/${pkg}/src/global-${name}.ts`);
    expect(files.filter((f) => flaggedGlobals.has(f))).toEqual(files);
  });

  it('leaves UI packages free to use browser globals', () => {
    expect(
      GLOBALS.some((name) => flaggedGlobals.has(`packages/ui-kit/src/global-${name}.ts`)),
    ).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldFiles, writeScaffold } from '../src/scaffold.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'elv_scaffold_'));
  dirs.push(d);
  return d;
};
const json = (files: Record<string, string>, path: string) => JSON.parse(files[path] ?? 'null');

describe('scaffoldFiles pure', () => {
  const files = scaffoldFiles({ kind: 'pure', name: 'widgets' });

  it('creates the package files under packages/<name>', () => {
    expect(Object.keys(files).sort()).toEqual([
      'packages/widgets/AGENTS.md',
      'packages/widgets/CLAUDE.md',
      'packages/widgets/package.json',
      'packages/widgets/src/index.ts',
      'packages/widgets/tsconfig.json',
    ]);
  });

  it('mirrors the domain package manifest', () => {
    const pkg = json(files, 'packages/widgets/package.json');
    expect(pkg.name).toBe('@elv/widgets');
    expect(pkg.type).toBe('module');
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
    expect(pkg.scripts.test).toBe('vitest run --reporter=dot --passWithNoTests');
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit -p . --pretty false');
    expect(pkg.devDependencies).toEqual({ '@elv/config': 'workspace:*', vitest: '5.1.0' });
  });

  it('extends the pure tsconfig with its own build info file', () => {
    const ts = json(files, 'packages/widgets/tsconfig.json');
    expect(ts.extends).toBe('@elv/config/tsconfig.pure.json');
    expect(ts.compilerOptions.tsBuildInfoFile).toBe(
      '../../node_modules/.cache/widgets.tsbuildinfo',
    );
    expect(ts.include).toEqual(['src']);
  });

  it('writes agent docs within the line cap and a CLAUDE.md stub', () => {
    const agents = files['packages/widgets/AGENTS.md'] ?? '';
    expect(agents.split('\n').length).toBeLessThanOrEqual(51);
    expect(agents).toContain('# widgets (`@elv/widgets`)');
    expect(files['packages/widgets/CLAUDE.md']).toBe('@AGENTS.md\n');
  });
});

describe('scaffoldFiles rn', () => {
  const files = scaffoldFiles({ kind: 'rn', name: 'screens' });

  it('uses catalog react versions and the ui tsconfig', () => {
    const pkg = json(files, 'packages/screens/package.json');
    expect(pkg.name).toBe('@elv/screens');
    expect(pkg.peerDependencies).toEqual({ react: '*', 'react-native': '*' });
    expect(pkg.devDependencies).toEqual({
      '@elv/config': 'workspace:*',
      '@types/react': 'catalog:',
      react: 'catalog:',
      'react-native': 'catalog:',
    });
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit -p . --pretty false');
    expect(json(files, 'packages/screens/tsconfig.json').extends).toBe(
      '@elv/config/tsconfig.ui.json',
    );
  });

  it('documents the Jest component test convention', () => {
    expect(files['packages/screens/AGENTS.md']).toContain('jest-expo');
  });
});

describe('scaffoldFiles module', () => {
  const files = scaffoldFiles({ kind: 'module', name: 'tv-player' });

  it('creates an Expo module config with all three platforms under modules/<name>', () => {
    expect(Object.keys(files).sort()).toEqual([
      'modules/tv-player/AGENTS.md',
      'modules/tv-player/CLAUDE.md',
      'modules/tv-player/expo-module.config.json',
      'modules/tv-player/package.json',
      'modules/tv-player/src/index.ts',
      'modules/tv-player/tsconfig.json',
    ]);
    expect(json(files, 'modules/tv-player/expo-module.config.json')).toEqual({
      platforms: ['apple', 'android', 'web'],
    });
  });

  it('exposes a native handle that is null on web', () => {
    const src = files['modules/tv-player/src/index.ts'] ?? '';
    expect(src).toContain("Platform.OS === 'web'");
    expect(src).toContain("requireOptionalNativeModule<TvPlayerNativeModule>('TvPlayer')");
  });

  it('declares expo-modules-core and states that native code is not generated', () => {
    const pkg = json(files, 'modules/tv-player/package.json');
    expect(pkg.name).toBe('@elv/tv-player');
    expect(pkg.dependencies['expo-modules-core']).toBeDefined();
    expect(files['modules/tv-player/AGENTS.md']).toContain('No native code is generated');
  });
});

describe('name validation', () => {
  it.each(['Widgets', 'a b', 'a/b', '..', 'a\b', '', '-a', 'a-', 'a--b', '1abc', 'a_b'])(
    'rejects %j',
    (name) => {
      expect(() => scaffoldFiles({ kind: 'pure', name })).toThrow(/invalid package name/);
    },
  );

  it('accepts lower-case kebab names', () => {
    expect(() => scaffoldFiles({ kind: 'pure', name: 'focus-core2' })).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    // @ts-expect-error exercising the runtime guard
    expect(() => scaffoldFiles({ kind: 'bogus', name: 'x' })).toThrow(/unknown kind/);
  });
});

describe('writeScaffold', () => {
  it('writes the files under the root', () => {
    const root = tempRoot();
    const written = writeScaffold(root, { kind: 'pure', name: 'widgets' });
    expect(written).toContain('packages/widgets/package.json');
  });

  it('refuses to overwrite an existing folder', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'packages', 'widgets'), { recursive: true });
    expect(() => writeScaffold(root, { kind: 'pure', name: 'widgets' })).toThrow(/already exists/);
  });

  it('refuses a name that exists as a package in another group', () => {
    const root = tempRoot();
    writeScaffold(root, { kind: 'pure', name: 'widgets' });
    expect(() => writeScaffold(root, { kind: 'module', name: 'widgets' })).toThrow(
      /already exists/,
    );
  });
});

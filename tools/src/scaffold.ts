import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Package shapes the scaffolder can create. */
export type PackageKind = 'pure' | 'rn' | 'module';

export interface ScaffoldOptions {
  kind: PackageKind;
  name: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VITEST_VERSION = '5.1.0';
const EXPO_MODULES_CORE_VERSION = '58.1.0';

const STRING_ARRAY = /\[\s*("[^"\n]*"(?:,\s*"[^"\n]*")*)\s*\]/g;
/** Serializes JSON the way Biome formats it: two spaces, short string arrays on one line. */
const json = (value: unknown) =>
  `${JSON.stringify(value, null, 2).replace(STRING_ARRAY, (_, items: string) => `[${items.replace(/,\s*/g, ', ')}]`)}\n`;
const pascal = (name: string) =>
  name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

function manifest(kind: PackageKind, name: string): unknown {
  const base = { name: `@elv/${name}`, private: true, version: '0.0.0', type: 'module' };
  const exports = { '.': './src/index.ts' };
  const typecheck = 'tsc --noEmit -p . --pretty false';
  if (kind === 'pure') {
    return {
      ...base,
      exports,
      scripts: { test: 'vitest run --reporter=dot --passWithNoTests', typecheck },
      devDependencies: { '@elv/config': 'workspace:*', vitest: VITEST_VERSION },
    };
  }
  if (kind === 'rn') {
    return {
      ...base,
      exports,
      scripts: { typecheck },
      peerDependencies: { react: '*', 'react-native': '*' },
      devDependencies: {
        '@elv/config': 'workspace:*',
        '@types/react': 'catalog:',
        react: 'catalog:',
        'react-native': 'catalog:',
      },
    };
  }
  return {
    ...base,
    exports,
    scripts: { typecheck },
    dependencies: { 'expo-modules-core': EXPO_MODULES_CORE_VERSION },
    peerDependencies: { expo: '*' },
    devDependencies: { '@elv/config': 'workspace:*' },
  };
}

function tsconfig(kind: PackageKind, name: string): string {
  return json({
    extends: `@elv/config/${kind === 'pure' ? 'tsconfig.pure.json' : 'tsconfig.ui.json'}`,
    compilerOptions: { tsBuildInfoFile: `../../node_modules/.cache/${name}.tsbuildinfo` },
    include: ['src'],
  });
}

function agentsDoc(kind: PackageKind, name: string): string {
  const head = [
    `# ${name} (\`@elv/${name}\`)`,
    '',
    'TODO: one sentence describing what this package owns.',
    '',
    '## Commands',
    `- \`pnpm --filter @elv/${name} typecheck\` type-checks this package.`,
  ];
  if (kind === 'pure') head.push(`- \`pnpm --filter @elv/${name} test\` runs its Vitest tests.`);
  head.push('- `pnpm -w check` runs every repository check.', '', '## Rules');
  const rules: Record<PackageKind, string[]> = {
    pure: [
      '- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.',
      '  Platform access goes through ports defined in `@elv/domain`.',
      '- Source-first: `exports` points at `src/index.ts`; there is no build step.',
      '- Allowed workspace dependencies: TODO (spec section 5.2).',
      '- Tests live beside the code as `*.test.ts`.',
    ],
    rn: [
      '- May import `react` and `react-native`; never `expo-*`, navigation libraries or `electron`.',
      '- Allowed workspace dependencies: TODO (spec section 5.2).',
      '- Source-first: `exports` points at `src/index.ts`; there is no build step.',
      '- Component tests use Jest with `jest-expo` and `@testing-library/react-native`',
      '  (`*.test.tsx` beside the component), run through a `test:jest` script.',
    ],
    module: [
      '- Expo native module: imports `expo-modules-core` and playback types only.',
      '- `expo-module.config.json` lists the platforms; the TypeScript entry returns `null` on web.',
      '- No native code is generated yet: add the Swift and Kotlin sources and the',
      '  `apple.modules` and `android.modules` entries when the module gets its first API.',
      '- Source-first: `exports` points at `src/index.ts`; there is no build step.',
    ],
  };
  return `${[...head, ...rules[kind]].join('\n')}\n`;
}

function moduleSource(name: string): string {
  const type = `${pascal(name)}NativeModule`;
  return [
    "import { Platform, requireOptionalNativeModule } from 'expo-modules-core';",
    '',
    `/** Shape of the native ${pascal(name)} module; replace with an interface at the first native API. */`,
    `export type ${type} = Record<string, never>;`,
    '',
    `type Native = ${type};`,
    '',
    '/** Returns the native module, or `null` on web and when the native build lacks it. */',
    `export function get${type}(): ${type} | null {`,
    "  if (Platform.OS === 'web') return null;",
    `  return requireOptionalNativeModule<Native>('${pascal(name)}');`,
    '}',
    '',
  ].join('\n');
}

/**
 * Builds the file map (repository-relative POSIX path to contents) for a new workspace package.
 * Throws when `name` is not lower-case kebab-case or `kind` is unknown.
 */
export function scaffoldFiles({ kind, name }: ScaffoldOptions): Record<string, string> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`invalid package name "${name}": use lower-case kebab-case (a-z, 0-9, -)`);
  }
  if (kind !== 'pure' && kind !== 'rn' && kind !== 'module') {
    throw new Error(`unknown kind "${String(kind)}": use pure, rn or module`);
  }
  const dir = `${kind === 'module' ? 'modules' : 'packages'}/${name}`;
  const files: Record<string, string> = {
    [`${dir}/package.json`]: json(manifest(kind, name)),
    [`${dir}/tsconfig.json`]: tsconfig(kind, name),
    [`${dir}/AGENTS.md`]: agentsDoc(kind, name),
    [`${dir}/CLAUDE.md`]: '@AGENTS.md\n',
    [`${dir}/src/index.ts`]: kind === 'module' ? moduleSource(name) : 'export {};\n',
  };
  if (kind === 'module') {
    files[`${dir}/expo-module.config.json`] = json({ platforms: ['apple', 'android', 'web'] });
  }
  return files;
}

/**
 * Writes a scaffold under `root` and returns the written relative paths.
 * Refuses when `packages/<name>` or `modules/<name>` already exists.
 */
export function writeScaffold(root: string, options: ScaffoldOptions): string[] {
  const files = scaffoldFiles(options);
  for (const group of ['packages', 'modules']) {
    if (existsSync(join(root, group, options.name))) {
      throw new Error(`${group}/${options.name} already exists`);
    }
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return Object.keys(files);
}

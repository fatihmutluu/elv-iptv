import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { exec } from '../../src/exec.ts';
import type { HermesRunPayload } from './entry.ts';

export interface RunHermesOptions {
  readonly root: string;
  readonly benchmark: 'small' | 'large';
  readonly requireRuntime: boolean;
  readonly hermesBin?: string;
}

export interface RunHermesReport {
  readonly compiledBytes: number;
  readonly executed: boolean;
  readonly hermesBin?: string;
  readonly result?: HermesRunPayload;
}

function hermescPlatformSubpath(platform: NodeJS.Platform): readonly [string, string] {
  if (platform === 'win32') return ['win64-bin', 'hermesc.exe'];
  if (platform === 'darwin') return ['osx-bin', 'hermesc'];
  return ['linux64-bin', 'hermesc'];
}

/** Finds the `hermesc` compiler binary shipped in `node_modules/.pnpm/hermes-compiler*`. */
export function findHermesc(root: string, platform: NodeJS.Platform = process.platform): string {
  const pnpmDir = join(root, 'node_modules', '.pnpm');
  const [osDir, exe] = hermescPlatformSubpath(platform);
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('hermes-compiler@')) continue;
      const candidate = join(
        pnpmDir,
        entry,
        'node_modules',
        'hermes-compiler',
        'hermesc',
        osDir,
        exe,
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`hermesc binary not found under ${pnpmDir} for ${platform}`);
}

/** Finds a standalone `hermes` VM CLI binary on `HERMES_BIN`, `PATH`, or `~/.local/hermes-*`. */
export function findHermesCli(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (explicit !== undefined) {
    return existsSync(explicit) ? explicit : undefined;
  }
  const fromEnv = env.HERMES_BIN;
  if (fromEnv !== undefined && fromEnv !== '') {
    return existsSync(fromEnv) ? fromEnv : undefined;
  }
  const exe = platform === 'win32' ? 'hermes.exe' : 'hermes';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  const localRoot = join(homedir(), '.local');
  if (existsSync(localRoot)) {
    for (const entry of readdirSync(localRoot)) {
      if (!entry.startsWith('hermes')) continue;
      const candidate = join(localRoot, entry, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Bundles `@elv/domain` + `@elv/sources` + synthetic simulator fixtures to ES2017, compiles with
 * `hermesc -O -emit-binary`, and executes the suite under the standalone `hermes` VM when present.
 */
export async function runHermesSources(options: RunHermesOptions): Promise<RunHermesReport> {
  const hermesc = findHermesc(options.root);
  const hermesBin = findHermesCli(options.hermesBin);
  if (options.requireRuntime && hermesBin === undefined) {
    throw new Error(
      options.hermesBin
        ? `Hermes runtime binary not found at ${options.hermesBin}`
        : 'Hermes runtime binary not found (set HERMES_BIN or install hermes on PATH)',
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), 'elv-hermes-sources-'));
  try {
    const entryPath = join(options.root, 'tools', 'bin', 'hermes', 'entry.ts');
    const es2022Path = join(scratch, 'sources-es2022.js');
    const es2017Path = join(scratch, 'sources-es2017.js');
    const bundlePath = join(scratch, 'sources-bundle.js');
    const bytecodePath = join(scratch, 'sources-bundle.hbc');

    const asyncIterPolyfill =
      'if(typeof Symbol==="function"&&!Symbol.asyncIterator){Object.defineProperty(Symbol,"asyncIterator",{value:Symbol.for("Symbol.asyncIterator")});globalThis.__ELV_POLYFILLED_ASYNC_ITERATOR__=true;}';

    for (const [target, out] of [
      ['es2022', es2022Path],
      ['es2017', es2017Path],
    ] as const) {
      const bundled = await exec(
        'pnpm',
        [
          '--filter',
          '@elv/desktop',
          'exec',
          'esbuild',
          entryPath,
          '--bundle',
          '--format=iife',
          `--target=${target}`,
          '--platform=neutral',
          '--main-fields=module,main',
          `--banner:js=${asyncIterPolyfill}`,
          `--define:__ELV_BENCHMARK_PROFILE__="${options.benchmark}"`,
          `--outfile=${out}`,
        ],
        { cwd: options.root, timeoutMs: 60_000 },
      );
      if (!bundled.ok) {
        throw new Error(`esbuild (${target}) failed:\n${bundled.output}`);
      }
    }

    const compiled = await exec(hermesc, ['-O', '-emit-binary', '-out', bytecodePath, es2017Path], {
      cwd: options.root,
      timeoutMs: 60_000,
    });
    if (!compiled.ok) {
      throw new Error(`hermesc compilation failed:\n${compiled.output}`);
    }
    const compiledBytes = statSync(bytecodePath).size;

    if (hermesBin === undefined) {
      return { compiledBytes, executed: false };
    }

    const transformScript = [
      "const fs = require('node:fs');",
      "const { createRequire } = require('node:module');",
      "const preset = require.resolve('babel-preset-expo');",
      "const babel = createRequire(preset)('@babel/core');",
      'const input = process.argv[1];',
      'const output = process.argv[2];',
      'const banner = process.argv[3];',
      'const code = fs.readFileSync(input, "utf8");',
      'const out = babel.transformSync(code, {',
      '  filename: input,',
      '  babelrc: false,',
      '  configFile: false,',
      '  compact: false,',
      "  caller: { name: 'metro', bundler: 'metro', platform: 'android' },",
      "  presets: [[preset, { unstable_transformProfile: 'default', enableBabelRuntime: false, modules: false }]],",
      '});',
      'fs.writeFileSync(output, banner + "\\n" + out.code, "utf8");',
    ].join(' ');

    const lowered = await exec(
      'pnpm',
      [
        '--filter',
        '@elv/ui-kit',
        'exec',
        'node',
        '-e',
        transformScript,
        es2022Path,
        bundlePath,
        asyncIterPolyfill,
      ],
      { cwd: options.root, timeoutMs: 60_000 },
    );
    if (!lowered.ok) {
      throw new Error(`babel-preset-expo transform failed:\n${lowered.output}`);
    }

    const executed = await exec(
      hermesBin,
      ['-O', '-Xmicrotask-queue', '-gc-max-heap=1073741824', bundlePath],
      { cwd: options.root, timeoutMs: 300_000 },
    );
    if (!executed.ok) {
      throw new Error(`hermes execution failed:\n${executed.output}`);
    }

    const marker = executed.output
      .split(/\r?\n/)
      .find((line) => line.startsWith('ELV_HERMES_SOURCES '));
    if (!marker) {
      throw new Error(`hermes did not print ELV_HERMES_SOURCES:\n${executed.output}`);
    }
    const result = JSON.parse(marker.slice('ELV_HERMES_SOURCES '.length)) as HermesRunPayload;
    return {
      compiledBytes,
      executed: true,
      hermesBin,
      result,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAgentsStubs } from './agents-stubs.ts';
import { exec } from './exec.ts';
import { checkFileSizes } from './file-size.ts';
import type { Check } from './runner.ts';
import { ENCODER_SKIP_MARKER, MEDIA_SKIP_MARKER } from './sim/media.ts';

const CODE_ROOTS = ['apps', 'modules', 'packages', 'tools'];

function trackedAndNewFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p !== '' && existsSync(join(root, p)));
}

function hookTests(root: string): string[] {
  const dir = join(root, '.claude', 'hooks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.test\.[cm]?js$/.test(f))
    .map((f) => join(dir, f));
}

/** Builds every project check, bound to the repository `root`. */
export function buildChecks(root: string): Check[] {
  const pnpm = (...args: string[]) => exec('pnpm', args, { cwd: root });
  return [
    {
      key: 'biome',
      run: () => pnpm('exec', 'biome', 'check', '--reporter=summary', '--colors=off'),
    },
    {
      key: 'typecheck',
      run: () => pnpm('-r', '--if-present', '--reporter=append-only', 'typecheck'),
    },
    {
      key: 'deps',
      run: () => {
        const dirs = CODE_ROOTS.filter((d) => existsSync(join(root, d)));
        return pnpm(
          'exec',
          'depcruise',
          '--config',
          '.dependency-cruiser.cjs',
          '--output-type',
          'err',
          ...dirs,
        );
      },
    },
    { key: 'knip', run: () => pnpm('exec', 'knip', '--no-progress') },
    {
      key: 'file-size',
      run: async () => {
        const contents: Record<string, string> = {};
        for (const p of trackedAndNewFiles(root)) {
          if (/\.(ts|tsx|mjs|cjs)$/.test(p)) contents[p] = readFileSync(join(root, p), 'utf8');
        }
        const { warnings, errors } = checkFileSizes(contents);
        const output = errors.map((e) => `error: ${e}`).join('\n');
        return { ok: errors.length === 0, output, notes: warnings.map((w) => `warn: ${w}`) };
      },
    },
    {
      key: 'stubs',
      run: async () => {
        const problems = checkAgentsStubs(root);
        return { ok: problems.length === 0, output: problems.join('\n') };
      },
    },
    {
      key: 'vitest',
      run: async () => {
        const r = await pnpm('-r', '--if-present', '--reporter=append-only', 'test');
        const notes: string[] = [];
        if (r.ok && r.output.includes(MEDIA_SKIP_MARKER))
          notes.push(`skip vitest: ${MEDIA_SKIP_MARKER} (FFmpeg is not on PATH)`);
        if (r.ok && r.output.includes(ENCODER_SKIP_MARKER))
          notes.push(`skip vitest: ${ENCODER_SKIP_MARKER} (see the sim-recipes output)`);
        return notes.length > 0 ? { ...r, notes } : r;
      },
    },
    { key: 'jest', run: () => pnpm('-r', '--if-present', '--reporter=append-only', 'test:jest') },
    {
      key: 'gitleaks-rules',
      run: async () => {
        const r = await exec('node', ['scripts/test-gitleaks-rules.mjs'], { cwd: root });
        const skipped = r.ok && /^SKIP/m.test(r.output);
        return skipped ? { ...r, notes: ['skip gitleaks-rules: gitleaks is not on PATH'] } : r;
      },
    },
    {
      key: 'hooks',
      run: async () => {
        const files = hookTests(root);
        if (files.length === 0) return { ok: true, output: '' };
        return exec('node', ['--test', ...files], { cwd: root });
      },
    },
  ];
}

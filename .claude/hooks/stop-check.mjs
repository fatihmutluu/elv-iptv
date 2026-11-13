#!/usr/bin/env node
// Stop hook: lints and type-checks what changed in the working tree before Claude finishes.
// Tools run through their JS entry points with process.execPath and file names only as argv
// elements, so no shell ever sees a file name (pnpm/npx .cmd shims would need one on Windows).
// Fails open: it exits 2 only when Biome or tsc report real errors.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_ROOTS = ['apps/', 'packages/', 'modules/', 'tools/'];
const BIOME_FILE = /\.(?:[cm]?[jt]s|[jt]sx|jsonc?)$/;
const MAX_SUMMARY_LINES = 40;
const TOOL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 150_000;

/** Parses `git status --porcelain -z` output into `{ status, path }` entries. */
export function parsePorcelainZ(output) {
  const parts = output.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    entries.push({ status, path: part.slice(3) });
    if (status.includes('R') || status.includes('C')) i++;
  }
  return entries;
}

/**
 * Maps repository-relative files to their workspace package folders: the nearest ancestor
 * holding a `package.json`, limited to apps/, packages/, modules/ and tools/. Deleted files
 * resolve through the directories that still exist. Returns sorted unique folders.
 */
export function packagesForFiles(files, root, exists = existsSync) {
  const found = new Set();
  for (const file of files) {
    const segments = file.split('/').slice(0, -1);
    for (let depth = segments.length; depth > 0; depth--) {
      const dir = segments.slice(0, depth).join('/');
      if (exists(join(root, dir, 'package.json'))) {
        if (PACKAGE_ROOTS.some((p) => `${dir}/`.startsWith(p))) found.add(dir);
        break;
      }
    }
  }
  return [...found].sort();
}

/**
 * Builds the Biome and `tsc --noEmit` invocations. `tools` holds the resolved JS entry points
 * (or null to skip a tool); every file name stays a single argv element.
 */
export function buildToolInvocations({ root, files, packages, tools, nodePath, hasTsconfig }) {
  const invocations = [];
  const lintable = files
    .filter((f) => BIOME_FILE.test(f))
    .map((f) => (f.startsWith('-') ? `./${f}` : f));
  if (tools.biome && lintable.length > 0) {
    invocations.push({
      name: 'biome',
      command: nodePath,
      args: [tools.biome, 'check', '--no-errors-on-unmatched', '--colors=off', ...lintable],
      cwd: root,
    });
  }
  if (tools.tsc) {
    for (const pkg of packages) {
      if (!hasTsconfig(pkg)) continue;
      invocations.push({
        name: `tsc ${pkg}`,
        command: nodePath,
        args: [tools.tsc, '--noEmit', '-p', pkg, '--pretty', 'false'],
        cwd: root,
      });
    }
  }
  return invocations;
}

/** Keeps the first `max` lines of `text` and notes how many were cut. */
export function summarize(text, max = MAX_SUMMARY_LINES) {
  const lines = text.trimEnd().split('\n');
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n... ${lines.length - max} more lines`;
}

function resolveRealTools(root) {
  const require = createRequire(join(root, 'package.json'));
  const attempt = (resolver) => {
    try {
      const path = resolver();
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  };
  return {
    biome:
      attempt(() =>
        join(dirname(require.resolve('@biomejs/biome/package.json')), 'bin', 'biome'),
      ) ?? attempt(() => join(root, 'node_modules', '@biomejs', 'biome', 'bin', 'biome')),
    tsc:
      attempt(() => require.resolve('typescript/lib/tsc.js')) ??
      attempt(() => join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')),
  };
}

function execGit(root, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    );
  });
}

/** Runs one invocation; `kind` is 'ok', 'failed' (real non-zero exit) or 'skipped' (timeout, spawn error). */
function runTool(invocation, timeout) {
  return new Promise((resolvePromise) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      (error, stdout, stderr) => {
        if (!error) return resolvePromise({ kind: 'ok', output: '' });
        const exited = typeof error.code === 'number' && !error.killed && !error.signal;
        resolvePromise({
          kind: exited ? 'failed' : 'skipped',
          output: `${stdout}${stderr}`,
          code: error.code,
        });
      },
    );
  });
}

/**
 * Core of the Stop hook. Returns `{ code, message }`: code 2 only when a tool reported real
 * errors; every internal problem returns code 0.
 */
export async function runStopCheck({
  root,
  input,
  resolveTools = resolveRealTools,
  run = runTool,
  toolTimeoutMs = TOOL_TIMEOUT_MS,
  totalBudgetMs = TOTAL_BUDGET_MS,
  nodePath = process.execPath,
}) {
  const pass = { code: 0, message: '' };
  if (input?.stop_hook_active === true) return pass;
  try {
    const entries = parsePorcelainZ(
      await execGit(root, ['status', '--porcelain', '-z', '--untracked-files=all']),
    );
    if (entries.length === 0) return pass;
    const all = entries.map((e) => e.path);
    const present = entries
      .filter((e) => !e.status.includes('D') && existsSync(join(root, e.path)))
      .map((e) => e.path);
    const invocations = buildToolInvocations({
      root,
      files: present,
      packages: packagesForFiles(all, root),
      tools: resolveTools(root),
      nodePath,
      hasTsconfig: (pkg) => existsSync(join(root, pkg, 'tsconfig.json')),
    });
    const deadline = Date.now() + totalBudgetMs;
    const failures = [];
    for (const invocation of invocations) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await run(invocation, Math.min(toolTimeoutMs, remaining));
      if (result.kind === 'failed') {
        failures.push(`[${invocation.name}] exit ${result.code}\n${result.output.trimEnd()}`);
      }
    }
    if (failures.length === 0) return pass;
    return { code: 2, message: summarize(`Fix these before finishing:\n${failures.join('\n')}`) };
  } catch {
    return pass;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  const root = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  const { code, message } = await runStopCheck({ root, input });
  if (code !== 0) process.stderr.write(`${message}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}

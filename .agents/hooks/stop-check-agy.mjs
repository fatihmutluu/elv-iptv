#!/usr/bin/env node
// Antigravity Stop hook for ELV IPTV: lints (Biome) and type-checks (tsc) dirty workspace files
// before the agent finishes a turn. Never passes filenames through a shell; fails open on internal errors.
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

/** Maps repository-relative files to their nearest workspace package folders. */
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

/** Builds direct Node invocations for Biome and `tsc --noEmit` without shell interpolation. */
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

/** Truncates output to `max` lines with a count of omitted lines. */
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

function execGit(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    );
  });
}

function defaultRunTool(invocation, timeout) {
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

/** Evaluates an Antigravity Stop hook payload and returns `{}` or `{ decision: "continue", reason }`. */
export async function evaluateStop(payload, deps = {}) {
  if (payload?.continuationActive === true) return {};
  if (payload?.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') return {};

  const startDir = payload?.cwd || payload?.workspacePaths?.[0] || process.cwd();
  const findRepoRoot =
    deps.findRepoRoot ??
    (async (dir) => (await execGit(dir, ['rev-parse', '--show-toplevel'])).trim());
  const isElvRepo =
    deps.isElvRepo ??
    ((root) =>
      existsSync(join(root, 'packages', 'domain')) && existsSync(join(root, 'biome.json')));
  const getPorcelainZ =
    deps.getPorcelainZ ??
    ((root) => execGit(root, ['status', '--porcelain', '-z', '--untracked-files=all']));
  const fileExists = deps.fileExists ?? existsSync;
  const resolveTools = deps.resolveTools ?? resolveRealTools;
  const runTool = deps.runTool ?? defaultRunTool;
  const nodePath = deps.nodePath ?? process.execPath;

  try {
    const root = await findRepoRoot(startDir);
    if (!root || !isElvRepo(root)) return {};

    const entries = parsePorcelainZ(await getPorcelainZ(root));
    if (entries.length === 0) return {};

    const all = entries.map((e) => e.path);
    const present = entries
      .filter((e) => !e.status.includes('D') && fileExists(join(root, e.path)))
      .map((e) => e.path);

    const invocations = buildToolInvocations({
      root,
      files: present,
      packages: packagesForFiles(all, root, fileExists),
      tools: resolveTools(root),
      nodePath,
      hasTsconfig: (pkg) => fileExists(join(root, pkg, 'tsconfig.json')),
    });

    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const failures = [];
    for (const invocation of invocations) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await runTool(invocation, Math.min(TOOL_TIMEOUT_MS, remaining));
      if (result.kind === 'failed') {
        failures.push(`[${invocation.name}] exit ${result.code}\n${result.output.trimEnd()}`);
      }
    }
    if (failures.length === 0) return {};
    return {
      decision: 'continue',
      reason: summarize(`Fix these before finishing:\n${failures.join('\n')}`),
    };
  } catch {
    return {};
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.stdout.write('{}\n');
    return 0;
  }
  const result = await evaluateStop(payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}

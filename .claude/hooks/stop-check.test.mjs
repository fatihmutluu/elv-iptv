import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildToolInvocations,
  packagesForFiles,
  parsePorcelainZ,
  runStopCheck,
  summarize,
} from './stop-check.mjs';

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function write(root, rel, content = '') {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

/** A throwaway repository with two packages and a committed baseline. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'elv_stop_'));
  temps.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'package.json', '{"name":"root"}');
  write(root, 'packages/domain/package.json', '{"name":"@elv/domain"}');
  write(root, 'packages/domain/tsconfig.json', '{}');
  write(root, 'packages/domain/src/index.ts', 'export {};\n');
  write(root, 'packages/domain/src/gone.ts', 'export {};\n');
  write(root, 'tools/package.json', '{"name":"@elv/tools"}');
  write(root, 'tools/src/a.ts', 'export {};\n');
  write(root, 'README.md', '# x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** Fake tool: records its argv to <name>.argv.json and exits with FAKE_EXIT (default 0). */
function fakeTool(root, name, { exit = 0, output = '' } = {}) {
  const script = join(root, '..', `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  const log = `${script}.argv.json`;
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${JSON.stringify(output)}) process.stdout.write(${JSON.stringify(output)});
process.exitCode = ${exit};
`,
  );
  temps.push(script, log);
  return { script, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const hasLog = (tool) => {
  try {
    return tool.calls().length > 0;
  } catch {
    return false;
  }
};

test('parsePorcelainZ keeps names with spaces and ampersands and skips rename origins', () => {
  const out = [' M packages/domain/src/a & b.ts', '?? new file.ts', 'R  new.ts', 'old.ts', ' D gone.ts', ''].join(
    '\0',
  );
  assert.deepEqual(parsePorcelainZ(out), [
    { status: ' M', path: 'packages/domain/src/a & b.ts' },
    { status: '??', path: 'new file.ts' },
    { status: 'R ', path: 'new.ts' },
    { status: ' D', path: 'gone.ts' },
  ]);
  assert.deepEqual(parsePorcelainZ(''), []);
});

test('packagesForFiles maps files to the nearest workspace package', () => {
  const root = fixtureRepo();
  write(root, 'apps/desktop/package.json', '{}');
  write(root, 'apps/desktop/renderer/package.json', '{}');
  const packages = packagesForFiles(
    [
      'packages/domain/src/a & b.ts',
      'packages/domain/src/index.ts',
      'apps/desktop/renderer/src/x.ts',
      'apps/desktop/main.ts',
      'tools/src/a.ts',
      'README.md',
      'docs/spec.md',
    ],
    root,
  );
  assert.deepEqual(packages, [
    'apps/desktop',
    'apps/desktop/renderer',
    'packages/domain',
    'tools',
  ]);
});

test('packagesForFiles maps a deleted file through its surviving directory', () => {
  const root = fixtureRepo();
  assert.deepEqual(packagesForFiles(['packages/domain/src/gone.ts'], root), ['packages/domain']);
});

test('packagesForFiles ignores files outside any package', () => {
  const root = fixtureRepo();
  assert.deepEqual(packagesForFiles(['package.json', 'scripts/x.mjs', '.claude/hooks/y.mjs'], root), []);
});

test('buildToolInvocations passes each file as one argv element to node entry points', () => {
  const nasty = 'packages/domain/src/a & b.ts';
  const invocations = buildToolInvocations({
    root: '/repo',
    files: [nasty, 'tools/src/a.ts', 'notes.md', '-odd.ts'],
    packages: ['packages/domain'],
    tools: { biome: '/nm/biome/bin/biome', tsc: '/nm/typescript/lib/tsc.js' },
    nodePath: '/usr/bin/node',
    hasTsconfig: () => true,
  });
  assert.equal(invocations.length, 2);
  const [biome, tsc] = invocations;
  assert.equal(biome.command, '/usr/bin/node');
  assert.equal(biome.args[0], '/nm/biome/bin/biome');
  assert.ok(biome.args.includes(nasty), 'nasty name is a single argv element');
  assert.ok(biome.args.includes('./-odd.ts'), 'dash-leading names are made unambiguous');
  assert.ok(!biome.args.includes('notes.md'), 'unsupported file types are not passed to Biome');
  assert.deepEqual(tsc.args, [
    '/nm/typescript/lib/tsc.js',
    '--noEmit',
    '-p',
    'packages/domain',
    '--pretty',
    'false',
  ]);
});

test('buildToolInvocations skips tools that cannot be resolved and packages without tsconfig', () => {
  const base = { root: '/r', files: ['a/b.ts'], packages: ['a'], nodePath: 'node' };
  assert.deepEqual(
    buildToolInvocations({ ...base, tools: { biome: null, tsc: null }, hasTsconfig: () => true }),
    [],
  );
  const onlyBiome = buildToolInvocations({
    ...base,
    tools: { biome: '/b', tsc: '/t' },
    hasTsconfig: () => false,
  });
  assert.deepEqual(onlyBiome.map((i) => i.name), ['biome']);
});

test('summarize keeps the first 40 lines and says how many were cut', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = summarize(text, 40);
  assert.equal(out.split('\n').length, 41);
  assert.match(out, /60 more lines/);
  assert.equal(summarize('short', 40), 'short');
});

test('stop_hook_active skips immediately without running anything', async () => {
  const root = fixtureRepo();
  write(root, 'packages/domain/src/index.ts', 'export const a = 1;\n');
  const biome = fakeTool(root, 'biome', { exit: 1 });
  const result = await runStopCheck({
    root,
    input: { stop_hook_active: true },
    resolveTools: () => ({ biome: biome.script, tsc: biome.script }),
  });
  assert.equal(result.code, 0);
  assert.equal(hasLog(biome), false);
});

test('nothing changed exits 0 without running tools', async () => {
  const root = fixtureRepo();
  const biome = fakeTool(root, 'biome', { exit: 1 });
  const result = await runStopCheck({
    root,
    input: {},
    resolveTools: () => ({ biome: biome.script, tsc: biome.script }),
  });
  assert.equal(result.code, 0);
  assert.equal(hasLog(biome), false);
});

test('a file named with ampersand and spaces reaches the tools as a single argv element', async () => {
  const root = fixtureRepo();
  const nasty = 'packages/domain/src/a & b.ts';
  write(root, nasty, 'export const x = 1;\n');
  write(root, 'README.md', '# changed\n');
  const biome = fakeTool(root, 'biome');
  const tsc = fakeTool(root, 'tsc');
  const result = await runStopCheck({
    root,
    input: {},
    resolveTools: () => ({ biome: biome.script, tsc: tsc.script }),
  });
  assert.equal(result.code, 0);
  const [biomeArgs] = biome.calls();
  assert.ok(biomeArgs.includes(nasty), JSON.stringify(biomeArgs));
  assert.ok(!biomeArgs.includes('README.md'));
  assert.deepEqual(tsc.calls(), [['--noEmit', '-p', 'packages/domain', '--pretty', 'false']]);
});

test('a deleted file triggers the package typecheck but is not given to Biome', async () => {
  const root = fixtureRepo();
  rmSync(join(root, 'packages/domain/src/gone.ts'));
  const biome = fakeTool(root, 'biome');
  const tsc = fakeTool(root, 'tsc');
  const result = await runStopCheck({
    root,
    input: {},
    resolveTools: () => ({ biome: biome.script, tsc: tsc.script }),
  });
  assert.equal(result.code, 0);
  assert.equal(hasLog(biome), false);
  assert.equal(tsc.calls().length, 1);
});

test('a changed file outside any package is linted but triggers no typecheck', async () => {
  const root = fixtureRepo();
  write(root, 'scripts/x.mjs', 'export {};\n');
  const biome = fakeTool(root, 'biome');
  const tsc = fakeTool(root, 'tsc');
  const result = await runStopCheck({
    root,
    input: {},
    resolveTools: () => ({ biome: biome.script, tsc: tsc.script }),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(biome.calls()[0].slice(-1), ['scripts/x.mjs']);
  assert.equal(hasLog(tsc), false);
});

test('real tool failures exit 2 with a concise summary', async () => {
  const root = fixtureRepo();
  write(root, 'packages/domain/src/index.ts', 'export const a: number = "x";\n');
  const biome = fakeTool(root, 'biome');
  const tsc = fakeTool(root, 'tsc', { exit: 2, output: "index.ts(1,14): error TS2322: bad\n" });
  const result = await runStopCheck({
    root,
    input: {},
    resolveTools: () => ({ biome: biome.script, tsc: tsc.script }),
  });
  assert.equal(result.code, 2);
  assert.match(result.message, /tsc/);
  assert.match(result.message, /TS2322/);
});

test('unresolvable tools, non-repositories and tool timeouts fail open', async () => {
  const root = fixtureRepo();
  write(root, 'packages/domain/src/index.ts', 'export const a = 1;\n');
  const none = await runStopCheck({ root, input: {}, resolveTools: () => ({ biome: null, tsc: null }) });
  assert.equal(none.code, 0);

  const notRepo = mkdtempSync(join(tmpdir(), 'elv_norepo_'));
  temps.push(notRepo);
  const outside = await runStopCheck({ root: notRepo, input: {}, resolveTools: () => ({ biome: null, tsc: null }) });
  assert.equal(outside.code, 0);

  const hang = join(root, '..', `hang-${Date.now()}.mjs`);
  writeFileSync(hang, 'setTimeout(() => {}, 60000);\n');
  temps.push(hang);
  const slow = await runStopCheck({
    root,
    input: {},
    resolveTools: () => ({ biome: hang, tsc: null }),
    toolTimeoutMs: 300,
  });
  assert.equal(slow.code, 0);
});

test('script exits 0 for stop_hook_active and for malformed stdin', () => {
  const script = fileURLToPath(new URL('./stop-check.mjs', import.meta.url));
  for (const input of [JSON.stringify({ stop_hook_active: true }), 'garbage', '']) {
    const r = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

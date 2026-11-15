import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePreToolUse } from './guard-pre-tool.mjs';
import { evaluateStop } from './stop-check-agy.mjs';

test('guard-pre-tool blocks git push --force variants and allows normal pushes', () => {
  for (const cmd of [
    'git push --force origin feat/x',
    'git push -f origin main',
    'git push --force-with-lease',
    'git push origin +HEAD:main',
    'pwsh -Command "git push --force"',
  ]) {
    const res = evaluatePreToolUse({
      toolCall: { name: 'run_command', args: { CommandLine: cmd } },
    });
    assert.equal(res.decision, 'deny', `expected deny for: ${cmd}`);
  }

  for (const cmd of [
    'git push -u origin feat/player-core',
    'git commit -m "fix: mention --force in message"',
    'pnpm check',
  ]) {
    const res = evaluatePreToolUse({
      toolCall: { name: 'run_command', args: { CommandLine: cmd } },
    });
    assert.equal(res.decision, 'allow', `expected allow for: ${cmd}`);
  }
});

test('guard-pre-tool requires confirmation for release/repo-destructive gh commands', () => {
  for (const cmd of [
    'gh release create v0.1.0',
    'gh repo delete fatihmutluu/elv-iptv',
    'gh repo edit --visibility private',
  ]) {
    const res = evaluatePreToolUse({
      toolCall: { name: 'run_command', args: { CommandLine: cmd } },
    });
    assert.equal(res.decision, 'force_ask', `expected force_ask for: ${cmd}`);
  }
});

test('guard-pre-tool blocks reading or dumping .env.local and signing keys while allowing pnpm run:app', () => {
  assert.equal(
    evaluatePreToolUse({
      toolCall: { name: 'read_file', args: { Path: 'C:\\work\\elv-iptv\\.env.local' } },
    }).decision,
    'deny',
  );
  assert.equal(
    evaluatePreToolUse({
      toolCall: { name: 'read_file', args: { Path: '/work/elv-iptv/release.keystore' } },
    }).decision,
    'deny',
  );
  assert.equal(
    evaluatePreToolUse({
      toolCall: { name: 'run_command', args: { CommandLine: 'Get-Content .env.local' } },
    }).decision,
    'deny',
  );
  assert.equal(
    evaluatePreToolUse({
      toolCall: { name: 'run_command', args: { CommandLine: 'pnpm run:app android-tv' } },
    }).decision,
    'allow',
  );
});

test('guard-pre-tool blocks editing generated native folders apps/*/android and apps/*/ios', () => {
  assert.equal(
    evaluatePreToolUse({
      toolCall: {
        name: 'edit_file',
        args: { Path: 'C:\\work\\elv-iptv\\apps\\tv-mobile\\android\\build.gradle' },
      },
    }).decision,
    'deny',
  );
  assert.equal(
    evaluatePreToolUse({
      toolCall: {
        name: 'write_file',
        args: { Path: '/work/elv-iptv/apps/tv-mobile/ios/Podfile' },
      },
    }).decision,
    'deny',
  );
  assert.equal(
    evaluatePreToolUse({
      toolCall: {
        name: 'edit_file',
        args: { Path: '/work/elv-iptv/modules/engine-media3/android/build.gradle' },
      },
    }).decision,
    'allow',
  );
});

test('stop-check-agy respects continuationActive, non-normal termination, and reports tool errors', async () => {
  assert.deepEqual(
    await evaluateStop({ continuationActive: true, terminationReason: 'NO_TOOL_CALL' }),
    {},
  );
  assert.deepEqual(
    await evaluateStop({ continuationActive: false, terminationReason: 'ERROR' }),
    {},
  );

  const failRes = await evaluateStop(
    { continuationActive: false, terminationReason: 'NO_TOOL_CALL', cwd: '/work/elv-iptv' },
    {
      findRepoRoot: async () => '/work/elv-iptv',
      isElvRepo: () => true,
      getPorcelainZ: async () => ' M packages/domain/src/index.ts\0',
      fileExists: (p) =>
        p.endsWith('package.json') || p.endsWith('tsconfig.json') || p.endsWith('index.ts'),
      resolveTools: () => ({ biome: '/biome.js', tsc: '/tsc.js' }),
      runTool: async (inv) =>
        inv.name === 'biome'
          ? { kind: 'failed', code: 1, output: 'format error on line 4\n' }
          : { kind: 'ok', output: '' },
    },
  );
  assert.equal(failRes.decision, 'continue');
  assert.match(failRes.reason, /format error on line 4/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseForcePush } from './block-force-push.mjs';

const blocked = [
  'git push --force',
  'git push -f',
  'git push -f origin main',
  'git push origin main --force',
  'git push -fu origin main',
  'git push -uf origin main',
  'git push --force-with-lease',
  'git push --force-with-lease=main:abc123 origin main',
  'git push --force-if-includes',
  'git push --mirror',
  'git push origin +main',
  'git push origin +HEAD:main',
  'git push origin feature --force',
  'git -C apps/tv-mobile push -f',
  'git -c user.name=x push --force',
  'git.exe push -f',
  '/usr/bin/git push --force',
  'FOO=1 git push -f',
  'git status && git push --force',
  'git fetch; git push -f',
  'git add . | git push -f',
  'echo $(git push -f)',
  'bash -c "git push --force"',
  "sh -c 'git push -f origin main'",
  'pwsh -Command "git push --force"',
  'git push --forc',
  'git push --mirr',
  'sudo git push -f',
  'git push \\\n--force',
  'git push origin main\ngit push -f',
  'cat <<EOF\nhi\nEOF\ngit push --force',
  'cat <<< "x"\ngit push -f',
  'echo $((1<<n))\ngit push --force',
  'git commit -m "see <<EOF"\ngit push -f',
  'cat <<EOF\ngit push -f',
  'cmd /c git push -f',
  'cmd.exe /c "git push --force"',
  'pwsh -Command git push -f',
  'powershell -NoProfile -Command git push --force origin main',
  'bash -c git push -f',
  'bash -lc "git push -f"',
  'eval git push -f',
  'sudo -u x git push -f',
  'sudo -n git push -f',
  'env -i git push -f',
  'env -u FOO git push -f',
  'nice -n 10 git push -f',
  'bash <<EOF\ngit push -f\nEOF',
  "sh -s <<'EOF'\ngit push --force\nEOF",
  'cat <<EOF | bash\ngit push -f\nEOF',
  'cat <<EOF | sh\ngit push --force\nEOF',
  'source /dev/stdin <<EOF\ngit push -f\nEOF',
  "pwsh <<'EOF'\ngit push -f\nEOF",
];

const allowed = [
  'git push',
  'git push origin main',
  'git push -u origin feature/force-the-issue',
  'git push --set-upstream origin chore/round-0-rn',
  'git push --follow-tags',
  'git push --tags',
  'git push --dry-run',
  'git pull --ff-only',
  'git commit -m "git push --force is banned"',
  'git commit -m "never use -f"',
  'git checkout -f main',
  'git clean -f',
  'echo "git push --force"',
  "grep -r 'git push -f' docs",
  'ls --force',
  'rm -f file.txt',
  'pnpm run force-build',
  'git log --format=%H -n 3',
  'gh pr create --title "fix: force push hook"',
  'git push origin main && git status',
  "cat > notes.md <<'EOF'\nrun `git push --force` never\nEOF",
  'git commit -F - <<EOF\nwhy: git push -f is banned\nEOF',
  "cat > run.sh <<'EOF'\ngit push -f\nEOF\nchmod +x run.sh",
  'cat <<EOF | tee out.txt\ngit push --force\nEOF',
  'echo $((1<<n))\ngit status',
  'cat <<< "git push -f"',
  'pwsh -Command git status',
  'cmd /c dir',
  'sudo -u x git status',
  'env -i FOO=1 ls',
  '',
  '   ',
];

test('blocks every force-push variant', () => {
  for (const command of blocked) {
    const result = parseForcePush(command);
    assert.equal(result.blocked, true, `expected block: ${JSON.stringify(command)}`);
    assert.match(result.reason, /force/i);
  }
});

test('allows normal pushes and commands that only mention force', () => {
  for (const command of allowed) {
    assert.equal(
      parseForcePush(command).blocked,
      false,
      `expected allow: ${JSON.stringify(command)}`,
    );
  }
});

test('fails open on unparseable input', () => {
  for (const input of [undefined, null, 42, {}, 'git push "unterminated -f']) {
    assert.doesNotThrow(() => parseForcePush(input));
  }
  assert.equal(parseForcePush(undefined).blocked, false);
  assert.equal(parseForcePush(42).blocked, false);
});

const script = fileURLToPath(new URL('./block-force-push.mjs', import.meta.url));
const run = (stdin) => spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8' });

test('script exits 2 with a reason for a force push', () => {
  const result = run(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' } }),
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /force/i);
});

test('script covers the PowerShell tool input', () => {
  const result = run(
    JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'git push -f origin main' } }),
  );
  assert.equal(result.status, 2);
});

test('script exits 0 for a normal push', () => {
  const result = run(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('script exits 0 on malformed or empty stdin', () => {
  assert.equal(run('not json').status, 0);
  assert.equal(run('').status, 0);
  assert.equal(run(JSON.stringify({ tool_name: 'Bash' })).status, 0);
});

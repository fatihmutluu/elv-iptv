import { describe, expect, it } from 'vitest';
import { commandLine, exec } from '../src/exec.ts';

describe('commandLine and shell safety', () => {
  it('quotes a command path containing spaces', () => {
    expect(
      commandLine('C:\\Program Files\\Android\\Sdk\\platform-tools\\adb.exe', ['devices']),
    ).toBe('"C:\\Program Files\\Android\\Sdk\\platform-tools\\adb.exe" devices');
  });

  it('executes a command path with spaces and does not expand %VAR% on Windows', async () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const result = await exec(
      process.execPath,
      ['-e', script, '%ELV_EXPAND_PROBE%', 'a %ELV_EXPAND_PROBE% b'],
      { cwd: process.cwd(), env: { ELV_EXPAND_PROBE: 'LEAKED' } },
    );
    expect(result.ok, result.output).toBe(true);
    expect(JSON.parse(result.output)).toEqual(['%ELV_EXPAND_PROBE%', 'a %ELV_EXPAND_PROBE% b']);
  });
});

describe('exec timeout', () => {
  it('kills a hung command and reports the timeout', async () => {
    const started = Date.now();
    const result = await exec('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 400,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('kills the entire grandchild tree before resolving on timeout', async () => {
    const script =
      "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' }); console.log('GPID=' + g.pid); setTimeout(()=>{},60000);";
    const result = await exec('node', ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    const match = /GPID=(\d+)/.exec(result.output);
    expect(match).not.toBeNull();
    const grandchildPid = Number(match?.[1]);
    let alive = false;
    try {
      process.kill(grandchildPid, 0);
      alive = true;
      process.kill(grandchildPid, 'SIGKILL');
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('leaves a command that finishes in time alone', async () => {
    const result = await exec('node', ['-e', 'console.log("hi")'], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.timedOut).toBeUndefined();
    expect(result.output).toContain('hi');
  });
});

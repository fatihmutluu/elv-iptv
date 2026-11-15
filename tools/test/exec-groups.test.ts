import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createGroupForwarder,
  exec,
  killPosixGroup,
  ownGroup,
  type SignalHost,
} from '../src/exec.ts';

type Listener = (signal: NodeJS.Signals) => void;

function fakeHost(gone: number[] = []) {
  const listeners = new Map<string, Listener[]>();
  const kills: [number, string][] = [];
  const host: SignalHost = {
    pid: 7,
    on(signal, listener) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
    },
    off(signal, listener) {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((l) => l !== listener),
      );
    },
    kill(pid, signal) {
      kills.push([pid, signal]);
      if (gone.includes(-pid)) throw new Error('ESRCH');
    },
  };
  const count = (signal: string) => listeners.get(signal)?.length ?? 0;
  const fire = (signal: NodeJS.Signals) => {
    for (const l of listeners.get(signal) ?? []) l(signal);
  };
  return { host, kills, count, fire };
}

describe('ownGroup', () => {
  it('gives only bounded commands off Windows their own process group', () => {
    expect(ownGroup('linux', 1000)).toBe(true);
    expect(ownGroup('darwin', 1)).toBe(true);
    expect(ownGroup('linux', undefined)).toBe(false);
    expect(ownGroup('win32', 1000)).toBe(false);
  });
});

describe('createGroupForwarder', () => {
  it('listens for SIGINT and SIGTERM only while a group is live', () => {
    const { host, count } = fakeHost();
    const groups = createGroupForwarder(host);
    expect(count('SIGINT')).toBe(0);
    groups.add(42);
    groups.add(43);
    expect([count('SIGINT'), count('SIGTERM')]).toEqual([1, 1]);
    groups.remove(42);
    expect(count('SIGINT')).toBe(1);
    groups.remove(43);
    groups.remove(43);
    expect([count('SIGINT'), count('SIGTERM')]).toEqual([0, 0]);
  });

  it('forwards the signal to every live group, then re-raises it on this process', () => {
    const { host, kills, count, fire } = fakeHost([42]);
    const groups = createGroupForwarder(host);
    groups.add(42);
    groups.add(43);
    fire('SIGTERM');
    expect(kills).toEqual([
      [-42, 'SIGTERM'],
      [-43, 'SIGTERM'],
      [7, 'SIGTERM'],
    ]);
    expect([count('SIGINT'), count('SIGTERM')]).toEqual([0, 0]);
  });
});

describe('killPosixGroup', () => {
  it('sends SIGKILL to -pid and polls kill(-pid, 0) until ESRCH before resolving', async () => {
    const calls: [number, NodeJS.Signals | 0][] = [];
    let aliveProbesRemaining = 3;
    const host = {
      kill(pid: number, signal: NodeJS.Signals | 0) {
        calls.push([pid, signal]);
        if (signal === 0) {
          if (aliveProbesRemaining-- > 0) return true;
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        return true;
      },
    };

    await killPosixGroup(500, host, 2_000, 10);
    expect(calls).toEqual([
      [-500, 'SIGKILL'],
      [-500, 0],
      [-500, 0],
      [-500, 0],
      [-500, 0],
    ]);
  });

  it('bounds waiting by timeoutMs if the process group stays un-reaped', async () => {
    const host = {
      kill() {
        return true;
      },
    };
    const started = Date.now();
    await killPosixGroup(501, host, 45, 10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe.skipIf(process.platform === 'win32')('exec process groups', () => {
  const runnerGroup = () =>
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();

  const commandGroup = async (timeoutMs?: number) => {
    const script =
      "process.stdout.write(require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim())";
    const result = await exec(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    expect(result.ok, result.output).toBe(true);
    return result.output.trim();
  };

  it('keeps an unbounded command in our process group so Ctrl+C reaches it', async () => {
    expect(await commandGroup()).toBe(runnerGroup());
  });

  it('starts a bounded command in its own group so a timeout kills all of it', async () => {
    const pgid = await commandGroup(20_000);
    expect(Number(pgid)).toBeGreaterThan(0);
    expect(pgid).not.toBe(runnerGroup());
  });
});

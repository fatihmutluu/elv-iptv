import { describe, expect, it } from 'vitest';
import { createGroupForwarder, exec, ownGroup, type SignalHost } from '../src/exec.ts';

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

describe.skipIf(process.platform === 'win32')('exec process groups', () => {
  const pidAndGroup = async (timeoutMs?: number) => {
    const result = await exec('sh', ['-c', 'ps -o pid=,pgid= -p $$'], {
      cwd: process.cwd(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return result.output.trim().split(/\s+/);
  };

  it('keeps an unbounded command in our process group so Ctrl+C reaches it', async () => {
    const [pid, group] = await pidAndGroup();
    expect(pid).not.toBe(group);
  });

  it('starts a bounded command in its own group so a timeout kills all of it', async () => {
    const [pid, group] = await pidAndGroup(20_000);
    expect(pid).toBe(group);
  });
});

import { Duplex, EventEmitter } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SpawnDeps, spawnMpv } from './process.ts';

class FakeChild extends EventEmitter {
  pid = 9001;
  kill(signal?: NodeJS.Signals): boolean {
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGKILL'));
    return true;
  }
}

function fakeSocket(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spawnMpv connect retry backoff (Wave Q4)', () => {
  it('uses 10 ms retry delay for the first 5 connect failures then escalates to 25 ms', async () => {
    const child = new FakeChild();
    const socket = fakeSocket();
    let remainingFailures = 7;
    const sleepDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (typeof ms === 'number' && (ms === 10 || ms === 25)) {
        sleepDelays.push(ms);
        return origSetTimeout(fn, 0, ...rest);
      }
      return origSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);

    const deps: SpawnDeps = {
      spawn: (() => child) as unknown as SpawnDeps['spawn'],
      connect: (() => {
        if (remainingFailures-- > 0) {
          const failed = fakeSocket();
          setImmediate(() => failed.emit('error', new Error('ENOENT')));
          return failed;
        }
        setImmediate(() => socket.emit('connect'));
        return socket;
      }) as unknown as SpawnDeps['connect'],
    };

    const proc = await spawnMpv(
      {
        executable: 'elv-mpv.exe',
        args: ['--idle=yes'],
        platform: 'win32',
        parentPid: 1,
      },
      deps,
    );

    expect(sleepDelays).toEqual([10, 10, 10, 10, 10, 25, 25]);
    proc.kill();
    await proc.exited;
  });
});

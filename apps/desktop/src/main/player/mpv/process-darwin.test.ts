import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, EventEmitter } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SpawnDeps } from './process.ts';
import { spawnMpv } from './process.ts';

class FakeDarwinChild extends EventEmitter {
  pid: number | undefined = 5100;
  killed = false;
  lastSignal: NodeJS.Signals | undefined;
  stdio: Array<Duplex | null> = [null, null, null];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.lastSignal = signal;
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
  exit(code: number): void {
    this.emit('exit', code, null);
  }
}

function fakeFd3(): Duplex & { written: string[] } {
  const written: string[] = [];
  const s = new Duplex({
    read() {},
    write(chunk: Buffer, _e, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  return Object.assign(s, { written });
}

function darwinWindowDeps(widthForAttempt: (attempt: number) => number) {
  const children: FakeDarwinChild[] = [];
  const deps: SpawnDeps = {
    spawn: (() => {
      const child = new FakeDarwinChild();
      const attempt = children.length;
      child.pid = 5000 + attempt;
      const sock = new Duplex({
        read() {},
        write(chunk: Buffer, _e, cb) {
          for (const line of chunk.toString().split('\n')) {
            if (!line) continue;
            const req = JSON.parse(line) as { request_id: number };
            const data = widthForAttempt(attempt);
            setImmediate(() =>
              sock.push(
                `${JSON.stringify({ request_id: req.request_id, error: 'success', data })}\n`,
              ),
            );
          }
          cb();
        },
      });
      child.stdio = [null, null, null, sock];
      children.push(child);
      return child;
    }) as unknown as SpawnDeps['spawn'],
    connect: (() => {
      throw new Error('unused');
    }) as unknown as SpawnDeps['connect'],
    retryDelayMs: 2,
    darwinWindowTimeoutMs: 15,
  };
  return { children, deps };
}

describe('spawnMpv (darwin)', () => {
  it('passes fd://3, pins LC_NUMERIC=C (#237) and escalates kill() to SIGKILL', async () => {
    const child = new FakeDarwinChild();
    const fd3 = fakeFd3();
    let seenOptions: Record<string, unknown> | undefined;
    let seenArgs: string[] = [];
    const deps: SpawnDeps = {
      spawn: ((_cmd: string, args: string[], options: Record<string, unknown>) => {
        seenArgs = args;
        seenOptions = options;
        child.stdio = [null, null, null, fd3];
        return child;
      }) as unknown as SpawnDeps['spawn'],
      connect: () => {
        throw new Error('unused on darwin');
      },
    };

    const proc = await spawnMpv(
      {
        executable: '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv',
        args: ['--idle=yes'],
        platform: 'darwin',
        parentPid: 99,
      },
      deps,
    );
    expect(proc.pid).toBe(5100);
    expect(seenArgs).toEqual(['--idle=yes', '--input-ipc-client=fd://3']);
    expect(seenOptions).toMatchObject({
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      env: expect.objectContaining({ LC_NUMERIC: 'C' }),
    });

    proc.kill();
    expect(child.lastSignal).toBe('SIGKILL');
    await expect(proc.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('forgets recorded pid when darwin child emits error after starting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-darwin-pid-'));
    const pidFile = join(dir, 'mpv-pids.json');
    try {
      const child = new FakeDarwinChild();
      const fd3 = fakeFd3();
      const deps: SpawnDeps = {
        spawn: (() => {
          child.stdio = [null, null, null, fd3];
          return child;
        }) as unknown as SpawnDeps['spawn'],
        connect: () => {
          throw new Error('unused');
        },
      };

      const proc = await spawnMpv(
        {
          executable: '/mpv',
          args: ['--idle=yes'],
          platform: 'darwin',
          parentPid: 1,
          pidFile,
        },
        deps,
      );
      expect(existsSync(pidFile)).toBe(true);
      child.emit('error', new Error('runtime fault'));
      await proc.exited;
      expect(existsSync(pidFile)).toBe(false);
      expect(child.lastSignal).toBe('SIGKILL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries with --force-window=immediate when osd-width stays 0 and rejects on timeout', async () => {
    const retry = darwinWindowDeps((i) => (i === 0 ? 0 : 640));
    const proc = await spawnMpv(
      {
        executable: '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv',
        args: ['--idle=yes', '--force-window=immediate'],
        platform: 'darwin',
        parentPid: 99,
      },
      retry.deps,
    );
    expect(retry.children).toHaveLength(2);
    expect(retry.children[0]?.killed).toBe(true);
    expect(proc.pid).toBe(5001);
    retry.children[1]?.exit(0);
    await proc.exited;

    const fail = darwinWindowDeps(() => 0);
    await expect(
      spawnMpv(
        {
          executable: '/Applications/ELV IPTV Player.app/Contents/MacOS/mpv',
          args: ['--force-window=immediate'],
          platform: 'darwin',
          parentPid: 99,
          connectTimeoutMs: 25,
        },
        fail.deps,
      ),
    ).rejects.toThrow(/window did not initialize/);
    expect(fail.children[0]?.killed).toBe(true);
  });

  it('rejects when child cannot start and aborts promptly before or during osd-width probe', async () => {
    const missing = new FakeDarwinChild();
    missing.pid = undefined;
    const missingDeps: SpawnDeps = {
      spawn: (() => {
        setTimeout(() => missing.emit('error', new Error('ENOENT')), 5);
        return missing;
      }) as unknown as SpawnDeps['spawn'],
      connect: () => {
        throw new Error('unused');
      },
    };
    await expect(
      spawnMpv(
        { executable: '/missing/mpv', args: [], platform: 'darwin', parentPid: 1 },
        missingDeps,
      ),
    ).rejects.toThrow(/could not start: ENOENT/);

    const ac1 = new AbortController();
    const child1 = new FakeDarwinChild();
    const sock1 = fakeFd3();
    const deps1: SpawnDeps = {
      spawn: (() => {
        child1.stdio = [null, null, null, sock1];
        ac1.abort();
        return child1;
      }) as unknown as SpawnDeps['spawn'],
      connect: () => {
        throw new Error('unused');
      },
    };
    await expect(
      spawnMpv(
        {
          executable: '/mpv',
          args: ['--idle=yes'],
          platform: 'darwin',
          parentPid: 1,
          signal: ac1.signal,
        },
        deps1,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(child1.killed).toBe(true);

    const ac2 = new AbortController();
    const child2 = new FakeDarwinChild();
    const sock2 = new Duplex({
      read() {},
      write(_chunk: Buffer, _e, cb) {
        setTimeout(() => ac2.abort(), 10);
        cb();
      },
    });
    const deps2: SpawnDeps = {
      spawn: (() => {
        child2.stdio = [null, null, null, sock2];
        return child2;
      }) as unknown as SpawnDeps['spawn'],
      connect: () => {
        throw new Error('unused');
      },
      darwinWindowTimeoutMs: 2000,
    };
    const startedAt = Date.now();
    await expect(
      spawnMpv(
        {
          executable: '/mpv',
          args: ['--force-window=immediate'],
          platform: 'darwin',
          parentPid: 1,
          signal: ac2.signal,
        },
        deps2,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(child2.killed).toBe(true);
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineEvent, LoadCommand } from '@elv/playback';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
  type QueueNextRequest,
} from '../../shared/player-ipc.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function createHarness(downloadsRoot?: string) {
  const handlers = new Map<
    string,
    (
      e: { sender: WebContentsLike; senderFrame?: { url?: string; top?: unknown } | null },
      ...args: unknown[]
    ) => unknown
  >();
  const listeners = new Map<
    string,
    (
      e: { sender: WebContentsLike; senderFrame?: { url?: string; top?: unknown } | null },
      ...args: unknown[]
    ) => unknown
  >();
  const ipcMain: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn),
    on: (ch, fn) => void listeners.set(ch, fn),
    removeHandler: (ch) => void handlers.delete(ch),
    removeListener: (ch) => void listeners.delete(ch),
  };

  const sent: Array<{ channel: string; payload: unknown }> = [];
  const sender: WebContentsLike = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
    once: () => undefined,
    on: () => undefined,
  };

  const calls: unknown[][] = [];
  const engine = {
    capabilities: {},
    spawns: 0,
    loadMode: 'replace',
    presenterKind: 'canvas',
    start: () => undefined,
    setArea: () => undefined,
    lastArea: undefined,
    load: (cmd: LoadCommand) => calls.push(['load', cmd]),
    queueNext: (req: QueueNextRequest) => calls.push(['queueNext', req]),
    clearQueue: () => calls.push(['clearQueue']),
    stop: (a: number) => calls.push(['stop', a]),
    release: () => calls.push(['release']),
    subscribe: () => () => undefined,
  } as unknown as MpvEngine;

  const logs: string[] = [];
  const dispose = registerPlayerIpc({
    ipcMain,
    createEngine: async () => engine,
    now: () => 1000,
    log: (line) => logs.push(line),
    ...(downloadsRoot !== undefined ? { downloadsRoot } : {}),
  });

  const senderFrame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
  senderFrame.top = senderFrame;

  return {
    open: () =>
      Promise.resolve(handlers.get(PLAYER_CHANNELS.open)?.({ sender, senderFrame })) as Promise<{
        engineId: string;
      }>,
    sendCommand: (engineId: string, command: unknown) =>
      listeners.get(PLAYER_CHANNELS.command)?.({ sender, senderFrame }, { engineId, command }),
    calls,
    sent,
    logs,
    dispose,
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('desktop player managed-download file:// security boundary', () => {
  it('rejects arbitrary file:// URLs at player-ipc shape guard while allowing managed video shapes', () => {
    const loadMsg = (url: string) => ({
      engineId: 'e1',
      command: { name: 'load', cmd: { attempt: 1, url, headers: {}, kind: 'vod' } },
    });

    for (const bad of [
      'file:///etc/passwd',
      'file:///C:/Windows/win.ini',
      'file:///downloads/../secret.mp4',
      'file:///downloads/movie.mp4?token=1',
      'file:///downloads/movie.mp4#frag',
      'file://evil.example/downloads/movie.mp4',
      'file:///downloads/script.sh',
    ]) {
      expect(isPlayerCommandMessage(loadMsg(bad)), `expected rejected: ${bad}`).toBe(false);
    }

    expect(isPlayerCommandMessage(loadMsg('file:///Users/demo/downloads/movie-1.mp4'))).toBe(true);
  });

  it('enforces realpath containment inside downloadsRoot on load and queueNext', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'elv-player-sec-'));
    tempDirs.push(base);
    const downloadsDir = path.join(base, 'downloads');
    const outsideDir = path.join(base, 'outside');
    await mkdir(downloadsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const validMovie = path.join(downloadsDir, 'movie-1.mp4');
    const validNextEp = path.join(downloadsDir, 'ep-2.mkv');
    const outsideMovie = path.join(outsideDir, 'secret.mp4');
    await writeFile(validMovie, Buffer.from([0, 0, 0, 24]));
    await writeFile(validNextEp, Buffer.from([0, 0, 0, 24]));
    await writeFile(outsideMovie, Buffer.from([0, 0, 0, 24]));

    const harness = createHarness(downloadsDir);
    const { engineId } = await harness.open();

    // Outside file:// is blocked before engine.load and emits structured error event.
    harness.sendCommand(engineId, {
      name: 'load',
      cmd: { attempt: 1, url: pathToFileURL(outsideMovie).toString(), headers: {}, kind: 'vod' },
    });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'load')).toHaveLength(0);
    const errorEvent = harness.sent.find(
      (m) =>
        m.channel === PLAYER_CHANNELS.event &&
        (m.payload as { event?: EngineEvent }).event?.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(harness.logs.join('\n')).not.toContain('secret.mp4');

    // Outside file:// is also blocked on queueNext.
    harness.sendCommand(engineId, {
      name: 'queueNext',
      request: {
        itemKey: 'ep:outside',
        stream: { url: pathToFileURL(outsideMovie).toString(), headers: {} },
      },
    });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'queueNext')).toHaveLength(0);

    // Symlink escape inside downloadsDir is blocked.
    const escapeLink = path.join(downloadsDir, 'escape.mp4');
    let symlinkCreated = false;
    try {
      await symlink(outsideMovie, escapeLink);
      symlinkCreated = true;
    } catch {
      // Skip symlink sub-case if Windows privilege denies symlinks.
    }
    if (symlinkCreated) {
      harness.sendCommand(engineId, {
        name: 'load',
        cmd: { attempt: 2, url: pathToFileURL(escapeLink).toString(), headers: {}, kind: 'vod' },
      });
      await flushAsync();
      expect(harness.calls.filter((c) => c[0] === 'load')).toHaveLength(0);
    }

    // Verified file inside downloadsDir succeeds on both load and queueNext.
    harness.sendCommand(engineId, {
      name: 'load',
      cmd: { attempt: 3, url: pathToFileURL(validMovie).toString(), headers: {}, kind: 'vod' },
    });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'load')).toHaveLength(1);

    harness.sendCommand(engineId, {
      name: 'queueNext',
      request: {
        itemKey: 'ep:2',
        stream: { url: pathToFileURL(validNextEp).toString(), headers: {} },
      },
    });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'queueNext')).toHaveLength(1);

    harness.dispose();

    // Fails closed when downloadsRoot is not configured.
    const closedHarness = createHarness(undefined);
    const { engineId: closedId } = await closedHarness.open();
    closedHarness.sendCommand(closedId, {
      name: 'load',
      cmd: { attempt: 1, url: pathToFileURL(validMovie).toString(), headers: {}, kind: 'vod' },
    });
    await flushAsync();
    expect(closedHarness.calls.filter((c) => c[0] === 'load')).toHaveLength(0);
    closedHarness.dispose();
  });

  it('does not let synchronous clearQueue cancel a pending file:// load, while stop still cancels load and clearQueue cancels queueNext', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'elv-player-seq-'));
    tempDirs.push(base);
    const downloadsDir = path.join(base, 'downloads');
    await mkdir(downloadsDir, { recursive: true });

    const validMovie = path.join(downloadsDir, 'ep-1.mp4');
    const validNextEp = path.join(downloadsDir, 'ep-2.mp4');
    await writeFile(validMovie, Buffer.from([0, 0, 0, 24]));
    await writeFile(validNextEp, Buffer.from([0, 0, 0, 24]));

    const harness = createHarness(downloadsDir);
    const { engineId } = await harness.open();

    // P0-1 regression: synchronous clearQueue right after file:// load must NOT cancel the load.
    harness.sendCommand(engineId, {
      name: 'load',
      cmd: { attempt: 1, url: pathToFileURL(validMovie).toString(), headers: {}, kind: 'vod' },
    });
    harness.sendCommand(engineId, { name: 'clearQueue' });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'clearQueue')).toHaveLength(1);
    expect(harness.calls.filter((c) => c[0] === 'load')).toHaveLength(1);

    // Synchronous stop after file:// load MUST still cancel the pending load.
    harness.sendCommand(engineId, {
      name: 'load',
      cmd: { attempt: 2, url: pathToFileURL(validMovie).toString(), headers: {}, kind: 'vod' },
    });
    harness.sendCommand(engineId, { name: 'stop', attempt: 3 });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'load')).toHaveLength(1);

    // Synchronous clearQueue after file:// queueNext MUST cancel the pending queueNext.
    harness.sendCommand(engineId, {
      name: 'queueNext',
      request: {
        itemKey: 'ep:2',
        stream: { url: pathToFileURL(validNextEp).toString(), headers: {} },
      },
    });
    harness.sendCommand(engineId, { name: 'clearQueue' });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'queueNext')).toHaveLength(0);

    // Synchronous load after file:// queueNext MUST cancel the pending queueNext.
    harness.sendCommand(engineId, {
      name: 'queueNext',
      request: {
        itemKey: 'ep:2',
        stream: { url: pathToFileURL(validNextEp).toString(), headers: {} },
      },
    });
    harness.sendCommand(engineId, {
      name: 'load',
      cmd: { attempt: 4, url: 'https://cdn.example/next.mp4', headers: {}, kind: 'vod' },
    });
    await flushAsync();
    expect(harness.calls.filter((c) => c[0] === 'queueNext')).toHaveLength(0);
    expect(harness.calls.filter((c) => c[0] === 'load')).toHaveLength(2);

    harness.dispose();
  });
});

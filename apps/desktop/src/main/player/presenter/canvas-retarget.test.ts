import { describe, expect, it, vi } from 'vitest';
import { fakeAppWindow } from '../testing/fake-windows.ts';
import {
  type CanvasPipeServerLike,
  type CanvasPipeSocketLike,
  createCanvasPresenter,
  type SharedTextureImportedLike,
  type SharedTextureImporterLike,
} from './canvas.ts';
import type { AppWindowLike } from './types.ts';

function fakePipeSocket() {
  const listeners = {
    data: new Set<(chunk: Buffer | string) => void>(),
    close: new Set<() => void>(),
    error: new Set<(err: Error) => void>(),
  };
  const written: string[] = [];
  let destroyed = false;

  const socket: CanvasPipeSocketLike = {
    write(chunk: string) {
      if (destroyed) throw new Error('socket destroyed');
      written.push(chunk);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of [...listeners.close]) fn();
    },
    on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void) {
      if (event === 'data') listeners.data.add(listener as (chunk: Buffer | string) => void);
      else if (event === 'close') listeners.close.add(listener as () => void);
      else listeners.error.add(listener as (err: Error) => void);
      return socket;
    },
  };

  return {
    socket,
    written,
    push(chunk: Buffer | string) {
      for (const fn of [...listeners.data]) fn(chunk);
    },
  };
}

function fakePipeServer() {
  const connectionListeners = new Set<(socket: CanvasPipeSocketLike) => void>();
  const server: CanvasPipeServerLike = {
    listen(_opts, onListening) {
      queueMicrotask(() => onListening());
      return server;
    },
    on(event: 'connection' | 'error', listener: (...args: never[]) => void) {
      if (event === 'connection') {
        connectionListeners.add(listener as (socket: CanvasPipeSocketLike) => void);
      }
      return server;
    },
    once: () => server,
    removeListener: () => server,
    close: () => server,
  };
  return {
    server,
    connect(sock: CanvasPipeSocketLike) {
      for (const fn of [...connectionListeners]) fn(sock);
    },
  };
}

describe('createCanvasPresenter.retargetWindow (Wave P3)', () => {
  it('rebinds FOLLOWED_EVENTS, routes frames to the new window mainFrame, recalculates scale factor, and resends R size', async () => {
    const winA = fakeAppWindow({ x: 0, y: 0, width: 1280, height: 720 });
    const winB = fakeAppWindow({ x: 100, y: 100, width: 960, height: 540 });
    winB.state.zoom = 1.25;
    const frameA = { id: 'frame-A' };
    const frameB = { id: 'frame-B' };
    const pipeServer = fakePipeServer();
    const socket = fakePipeSocket();
    const sentFrames: unknown[] = [];
    const imported: SharedTextureImportedLike = { release: vi.fn() };
    const sharedTexture: SharedTextureImporterLike = {
      importSharedTexture: vi.fn(() => imported),
      sendSharedTexture: vi.fn(async ({ frame }) => {
        sentFrames.push(frame);
      }),
    };

    const presenter = createCanvasPresenter({
      appWindow: winA.window,
      engineId: 'engine-1',
      sharedTexture,
      getMainFrame: (win?: AppWindowLike) => (win === winB.window ? frameB : frameA),
      getScaleFactor: (win?: AppWindowLike) => (win === winB.window ? 2 : 1),
      createPipeServer: () => pipeServer.server,
      generatePipeName: () => '\\\\.\\pipe\\elv-test-retarget',
    });

    await presenter.prepare();
    pipeServer.connect(socket.socket);
    presenter.setArea({ x: 0, y: 0, width: 640, height: 360, visible: true });
    expect(socket.written).toEqual(['R 640 360\n']);

    // Surface + frame go to winA's mainFrame
    socket.push('S 1 0 12345 640 360\nF 1 0 640 360\n');
    await Promise.resolve();
    expect(sentFrames).toEqual([frameA]);

    // Retarget to winB (zoom 1.25 * scaleFactor 2 = 2.5 => 1600x900)
    expect(typeof presenter.retargetWindow).toBe('function');
    presenter.retargetWindow?.(winB.window);

    // Resets sent size and sends R with winB's scale factor + zoom immediately
    expect(socket.written).toContain('R 1600 900\n');

    // Old winA events no longer trigger syncSize; winB events do
    const writesBeforeOldEvent = socket.written.length;
    winA.state.zoom = 3;
    winA.emit('resize');
    expect(socket.written.length).toBe(writesBeforeOldEvent);

    winB.state.zoom = 1;
    winB.emit('resize');
    expect(socket.written.at(-1)).toBe('R 1280 720\n');

    // Next video frame delivers to winB's mainFrame even after winA is destroyed
    winA.state.destroyed = true;
    socket.push('F 1 0 640 360\n');
    await Promise.resolve();
    expect(sentFrames).toEqual([frameA, frameB]);

    // toggleFullscreen operates on winB
    presenter.toggleFullscreen();
    expect(winB.window.isFullScreen()).toBe(true);

    // dispose detaches listeners from winB cleanly
    presenter.dispose();
    const writesAfterDispose = socket.written.length;
    winB.emit('resize');
    expect(socket.written.length).toBe(writesAfterDispose);
  });
});

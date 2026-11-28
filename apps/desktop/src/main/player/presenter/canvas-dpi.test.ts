import { describe, expect, it, vi } from 'vitest';
import { fakeAppWindow } from '../testing/fake-windows.ts';
import { areaToScreen, roundEdges } from './bounds.ts';
import {
  type CanvasPipeServerLike,
  type CanvasPipeSocketLike,
  createCanvasPresenter,
  type SharedTextureImportedLike,
  type SharedTextureImporterLike,
} from './canvas.ts';

function fakePipeSocket() {
  const listeners = {
    data: new Set<(chunk: Buffer | string) => void>(),
    close: new Set<() => void>(),
    error: new Set<(err: Error) => void>(),
  };
  const written: string[] = [];
  const socket: CanvasPipeSocketLike = {
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
    destroy() {
      for (const fn of [...listeners.close]) fn();
    },
    on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void) {
      if (event === 'data') listeners.data.add(listener as (chunk: Buffer | string) => void);
      else if (event === 'close') listeners.close.add(listener as () => void);
      else listeners.error.add(listener as (err: Error) => void);
      return socket;
    },
  };
  return { socket, written };
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

describe('roundEdges & canvas.ts fractional-DPI alignment', () => {
  it('exports roundEdges from bounds.ts and keeps adjacent rects flush without -0', () => {
    const left = roundEdges(0, 0, 640.4 * 1.25, 360.4 * 1.25);
    const right = roundEdges(640.4 * 1.25, 0, 1280.8 * 1.25, 360.4 * 1.25);
    expect(left.x + left.width).toBe(right.x);
    expect(Object.is(roundEdges(-0.2, -0.2, 10, 10).x, 0)).toBe(true);
    expect(roundEdges(5, 5, 5, 5)).toEqual({ x: 5, y: 5, width: 1, height: 1 });
  });

  it('aligns canvas R dimensions with areaToScreen across 1.25x, 1.5x scaling and fractional area.x/y', async () => {
    const app = fakeAppWindow({ x: 0, y: 0, width: 1920, height: 1080 });
    const pipe = fakePipeServer();
    const sock = fakePipeSocket();
    let scaleFactor = 1.25;
    const imported: SharedTextureImportedLike = { release: vi.fn() };
    const sharedTexture: SharedTextureImporterLike = {
      importSharedTexture: vi.fn(() => imported),
      sendSharedTexture: vi.fn(async () => undefined),
    };

    const presenter = createCanvasPresenter({
      appWindow: app.window,
      engineId: 'engine-dpi',
      sharedTexture,
      getMainFrame: () => ({ id: 'frame' }),
      getScaleFactor: () => scaleFactor,
      createPipeServer: () => pipe.server,
      generatePipeName: () => '\\\\.\\pipe\\elv-test-dpi',
    });

    await presenter.prepare();
    pipe.connect(sock.socket);

    const cases = [
      // 125% scaling with non-integer CSS offsets where independent width rounding drifts by 1 px
      { scale: 1.25, zoom: 1, area: { x: 10.4, y: 20.6, width: 100.5, height: 50.2 } },
      // 150% scaling with odd fractional position causing edge vs extent mismatch
      { scale: 1.5, zoom: 1, area: { x: 33.3, y: 17.7, width: 640.3, height: 360.3 } },
      // 125% scaling * 1.1x Electron page zoom
      { scale: 1.25, zoom: 1.1, area: { x: 15.2, y: 9.8, width: 853.3, height: 480.2 } },
      // 150% scaling * 1.25x Electron page zoom (1.875x total) at y=20 vs y=40
      { scale: 1.5, zoom: 1.25, area: { x: 10, y: 20, width: 800, height: 450 } },
      { scale: 1.5, zoom: 1.25, area: { x: 30, y: 40, width: 800, height: 450 } },
    ] as const;

    const zeroContent = { x: 0, y: 0, width: 1920, height: 1080 };
    for (const c of cases) {
      scaleFactor = c.scale;
      app.state.zoom = c.zoom;
      const fullArea = { ...c.area, visible: true };
      const prevCount = sock.written.length;
      presenter.setArea(fullArea);
      const expected = areaToScreen(zeroContent, fullArea, c.scale * c.zoom);
      expect(sock.written.length).toBeGreaterThan(prevCount);
      expect(sock.written.at(-1)).toBe(`R ${expected.width} ${expected.height}\n`);
    }

    presenter.dispose();
  });

  it('keeps adjacent Multi-View tiles flush at 125% and 150% scaling with zero 1px seam', async () => {
    for (const scaleFactor of [1.25, 1.5]) {
      const splitX = 640.3;
      const totalWidth = 1280.6;
      const leftArea = { x: 0, y: 40.3, width: splitX, height: 360.4, visible: true };
      const rightArea = {
        x: splitX,
        y: 40.3,
        width: totalWidth - splitX,
        height: 360.4,
        visible: true,
      };
      const totalExpected = roundEdges(
        0,
        40.3 * scaleFactor,
        totalWidth * scaleFactor,
        (40.3 + 360.4) * scaleFactor,
      );

      const measure = async (area: typeof leftArea): Promise<{ w: number; h: number }> => {
        const app = fakeAppWindow();
        const pipe = fakePipeServer();
        const sock = fakePipeSocket();
        const presenter = createCanvasPresenter({
          appWindow: app.window,
          engineId: 'e-tile',
          sharedTexture: {
            importSharedTexture: () => ({ release: vi.fn() }),
            sendSharedTexture: async () => undefined,
          },
          getMainFrame: () => ({ id: 'f' }),
          getScaleFactor: () => scaleFactor,
          createPipeServer: () => pipe.server,
          generatePipeName: () => '\\\\.\\pipe\\elv-test-tile',
        });
        await presenter.prepare();
        pipe.connect(sock.socket);
        presenter.setArea(area);
        const last = sock.written.at(-1) ?? '';
        presenter.dispose();
        const [, w, h] = /^R (\d+) (\d+)\n$/.exec(last) ?? [];
        return { w: Number(w), h: Number(h) };
      };

      const leftPx = await measure(leftArea);
      const rightPx = await measure(rightArea);
      expect(leftPx.w + rightPx.w).toBe(totalExpected.width);
      expect(leftPx.h).toBe(totalExpected.height);
      expect(rightPx.h).toBe(totalExpected.height);
    }
  });
});

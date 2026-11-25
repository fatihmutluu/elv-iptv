import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoFrameLike } from '../../../src/shared/player-ipc.ts';
import type { DesktopEngine } from './desktop-engine.ts';

interface EffectRecord {
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

const hookState = vi.hoisted(() => ({
  cursor: 0,
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<EffectRecord | undefined>,
  pendingEffects: [] as Array<{ index: number; create: () => (() => void) | undefined }>,
  reset() {
    this.cursor = 0;
    this.refs = [];
    this.effects = [];
    this.pendingEffects = [];
  },
  beginRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  flushEffects() {
    const queue = this.pendingEffects.splice(0);
    for (const item of queue) {
      const prev = this.effects[item.index];
      prev?.cleanup?.();
      const cleanup = item.create();
      const record = this.effects[item.index];
      if (record) {
        record.cleanup = cleanup;
      }
    }
  },
  unmount() {
    for (const rec of this.effects) {
      rec?.cleanup?.();
    }
    this.reset();
  },
}));

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!prev || !next || prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef<T>(initial: T) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      if (!hookState.refs[idx]) {
        hookState.refs[idx] = { current: initial };
      }
      return hookState.refs[idx] as { current: T };
    },
    useEffect(create: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      const prev = hookState.effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        hookState.effects[idx] = { deps, cleanup: prev?.cleanup };
        hookState.pendingEffects.push({ index: idx, create });
      }
    },
  };
});

import { PlayerCanvas, type PlayerCanvasProps } from './PlayerCanvas.tsx';

function createFakeCanvas(opts?: { throwOnDraw?: boolean; nullContext?: boolean }) {
  let widthVal = 0;
  let heightVal = 0;
  const widthSets: number[] = [];
  const heightSets: number[] = [];
  const drawImage = vi.fn(() => {
    if (opts?.throwOnDraw) throw new Error('gpu draw failed');
  });
  const clearRect = vi.fn();
  const ctx = { drawImage, clearRect };
  const canvas = {
    get width() {
      return widthVal;
    },
    set width(v: number) {
      widthVal = v;
      widthSets.push(v);
    },
    get height() {
      return heightVal;
    },
    set height(v: number) {
      heightVal = v;
      heightSets.push(v);
    },
    getContext: vi.fn((kind: string) => (kind === '2d' && !opts?.nullContext ? ctx : null)),
  };
  return { canvas, ctx, widthSets, heightSets };
}

function createFakeEngine() {
  let frameListener: ((frame: VideoFrameLike) => void) | undefined;
  const unsub = vi.fn(() => {
    frameListener = undefined;
  });
  const engine = {
    engineId: 'e1',
    onFrame: vi.fn((listener: (frame: VideoFrameLike) => void) => {
      frameListener = listener;
      return unsub;
    }),
  } as unknown as DesktopEngine;
  return {
    engine,
    unsub,
    deliver(frame: VideoFrameLike) {
      frameListener?.(frame);
    },
  };
}

function createFrame(width: number, height: number) {
  return {
    codedWidth: width,
    codedHeight: height,
    displayWidth: width,
    displayHeight: height,
    close: vi.fn<() => void>(),
  };
}

function renderCanvas(
  props: PlayerCanvasProps,
  canvasNode: ReturnType<typeof createFakeCanvas>['canvas'] | null,
): ReactElement<Record<string, unknown>> {
  hookState.beginRender();
  const element = PlayerCanvas(props) as ReactElement<Record<string, unknown>>;
  const ref = element.props.ref as { current: unknown } | undefined;
  if (ref) ref.current = canvasNode;
  hookState.flushEffects();
  return element;
}

describe('PlayerCanvas', () => {
  beforeEach(() => {
    hookState.reset();
  });

  it('draws incoming frames, syncs canvas dimensions only on change, and always closes frames', () => {
    const { engine, deliver } = createFakeEngine();
    const { canvas, ctx, widthSets, heightSets } = createFakeCanvas();

    const el = renderCanvas({ engine, visible: true }, canvas);
    expect(el.type).toBe('canvas');
    expect(el.props['data-testid']).toBe('player-canvas');
    expect(el.props.style).toMatchObject({
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      display: 'block',
      pointerEvents: 'none',
      objectFit: 'contain',
      opacity: 1,
    });

    const f1 = createFrame(1920, 1080);
    deliver(f1);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(widthSets).toEqual([1920]);
    expect(heightSets).toEqual([1080]);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(f1, 0, 0, 1920, 1080);
    expect(f1.close).toHaveBeenCalledTimes(1);

    // Same-dimension frame must NOT rewrite canvas.width / canvas.height.
    const f2 = createFrame(1920, 1080);
    deliver(f2);
    expect(widthSets).toEqual([1920]);
    expect(heightSets).toEqual([1080]);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(f2.close).toHaveBeenCalledTimes(1);

    // Resolution change updates backing dimensions once.
    const f3 = createFrame(1280, 720);
    deliver(f3);
    expect(widthSets).toEqual([1920, 1280]);
    expect(heightSets).toEqual([1080, 720]);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(f3, 0, 0, 1280, 720);
    expect(f3.close).toHaveBeenCalledTimes(1);

    hookState.unmount();
  });

  it('uses displayWidth/displayHeight over codedWidth/codedHeight for anamorphic container DAR (#124)', () => {
    const { engine, deliver } = createFakeEngine();
    const { canvas, ctx } = createFakeCanvas();

    renderCanvas({ engine, visible: true }, canvas);

    // Anamorphic PAL 720x576 with 16:9 DAR -> displayWidth 1024, displayHeight 576
    const anamorphicPal = {
      codedWidth: 720,
      codedHeight: 576,
      displayWidth: 1024,
      displayHeight: 576,
      close: vi.fn<() => void>(),
    };
    deliver(anamorphicPal);
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(576);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(anamorphicPal, 0, 0, 1024, 576);
    expect(anamorphicPal.close).toHaveBeenCalledTimes(1);

    // Falls back to codedWidth/codedHeight when display dimensions are absent or non-positive
    const fallbackFrame = {
      codedWidth: 1280,
      codedHeight: 720,
      close: vi.fn<() => void>(),
    };
    deliver(fallbackFrame);
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(fallbackFrame, 0, 0, 1280, 720);
    expect(fallbackFrame.close).toHaveBeenCalledTimes(1);

    hookState.unmount();
  });

  it('maps resizeMode fit, fill, and stretch to CSS objectFit contain, cover, and fill (#151)', () => {
    const { engine } = createFakeEngine();
    const { canvas } = createFakeCanvas();

    const fitEl = renderCanvas({ engine, resizeMode: 'fit', visible: true }, canvas);
    expect((fitEl.props.style as Record<string, unknown>).objectFit).toBe('contain');

    const fillEl = renderCanvas({ engine, resizeMode: 'fill', visible: true }, canvas);
    expect((fillEl.props.style as Record<string, unknown>).objectFit).toBe('cover');

    const stretchEl = renderCanvas({ engine, resizeMode: 'stretch', visible: true }, canvas);
    expect((stretchEl.props.style as Record<string, unknown>).objectFit).toBe('fill');

    hookState.unmount();
  });

  it('closes VideoFrame in finally even when ctx.drawImage or frame.close throws and skips zero-size frames', () => {
    const { engine, deliver } = createFakeEngine();
    const { canvas, ctx } = createFakeCanvas({ throwOnDraw: true });

    renderCanvas({ engine, visible: true }, canvas);
    const frame = createFrame(640, 360);
    expect(() => deliver(frame)).not.toThrow();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(frame.close).toHaveBeenCalledTimes(1);

    const badClose = createFrame(640, 360);
    badClose.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    expect(() => deliver(badClose)).not.toThrow();
    expect(badClose.close).toHaveBeenCalledTimes(1);

    const emptyFrame = createFrame(0, 0);
    deliver(emptyFrame);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(emptyFrame.close).toHaveBeenCalledTimes(1);

    hookState.unmount();
  });

  it('suppresses drawing, sets opacity 0, clears canvas on hidden/failed state and unmount, and still closes frames', () => {
    const { engine, unsub, deliver } = createFakeEngine();
    const { canvas, ctx } = createFakeCanvas();

    renderCanvas({ engine, visible: true }, canvas);
    const f1 = createFrame(1280, 720);
    deliver(f1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.clearRect).not.toHaveBeenCalled();

    // Transition to visible=false (failed state): clears canvas and hides via opacity 0.
    const hiddenEl = renderCanvas({ engine, visible: false }, canvas);
    expect((hiddenEl.props.style as Record<string, unknown>).opacity).toBe(0);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1280, 720);

    // Frames arriving while hidden are closed without drawing.
    const f2 = createFrame(1280, 720);
    deliver(f2);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(f2.close).toHaveBeenCalledTimes(1);

    // Unmount unsubscribes and clears canvas again.
    hookState.unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(ctx.clearRect).toHaveBeenCalledTimes(2);
  });

  it('closes frames safely when canvas ref or 2d context is missing', () => {
    const { engine, deliver } = createFakeEngine();

    renderCanvas({ engine, visible: true }, null);
    const f1 = createFrame(800, 600);
    deliver(f1);
    expect(f1.close).toHaveBeenCalledTimes(1);

    hookState.unmount();

    const { engine: engine2, deliver: deliver2 } = createFakeEngine();
    const { canvas } = createFakeCanvas({ nullContext: true });
    renderCanvas({ engine: engine2, visible: true }, canvas);
    const f2 = createFrame(800, 600);
    deliver2(f2);
    expect(f2.close).toHaveBeenCalledTimes(1);

    hookState.unmount();
  });

  it('requests an opaque (alpha: false) 2D context once, caches it across frames, and clears with opaque black fillRect', () => {
    const { engine, deliver } = createFakeEngine();
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const ctx = { drawImage, fillRect, fillStyle: '' };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
    };

    renderCanvas(
      { engine, visible: true },
      canvas as unknown as ReturnType<typeof createFakeCanvas>['canvas'],
    );
    deliver(createFrame(1920, 1080));
    deliver(createFrame(1920, 1080));
    expect(canvas.getContext).toHaveBeenCalledTimes(1);
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { alpha: false });
    expect(drawImage).toHaveBeenCalledTimes(2);

    renderCanvas(
      { engine, visible: false },
      canvas as unknown as ReturnType<typeof createFakeCanvas>['canvas'],
    );
    expect(ctx.fillStyle).toBe('#000000');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1920, 1080);

    hookState.unmount();
  });
});

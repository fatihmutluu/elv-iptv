import { type ReactElement, useEffect, useRef } from 'react';
import type { DesktopEngine } from './desktop-engine.ts';

/** Props of {@link PlayerCanvas}. */
export interface PlayerCanvasProps {
  engine: DesktopEngine;
  /** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover, `stretch` fills bounds ignoring aspect). */
  resizeMode?: 'fit' | 'fill' | 'stretch';
  /** When `false`, incoming frames are closed without drawing and the canvas is cleared. */
  visible: boolean;
}

function acquireOpaqueContext(
  canvas: HTMLCanvasElement,
  cached: CanvasRenderingContext2D | null,
): CanvasRenderingContext2D | null {
  if (cached !== null) return cached;
  return canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
}

function clearCanvas(canvas: HTMLCanvasElement | null, ctx: CanvasRenderingContext2D | null): void {
  if (!canvas) return;
  const resolved = acquireOpaqueContext(canvas, ctx);
  if (!resolved) return;
  if (typeof resolved.fillRect === 'function') {
    resolved.fillStyle = '#000000';
    resolved.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    resolved.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function capturePreviousFrame(
  canvas: HTMLCanvasElement,
  scratchRef: { current: HTMLCanvasElement | null },
  scratchCtxRef: { current: CanvasRenderingContext2D | null },
): HTMLCanvasElement | null {
  if (
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function'
  ) {
    return null;
  }
  try {
    const scratch = scratchRef.current ?? document.createElement('canvas');
    scratchRef.current = scratch;
    const scratchCtx = acquireOpaqueContext(scratch, scratchCtxRef.current);
    if (!scratchCtx) return null;
    scratchCtxRef.current = scratchCtx;
    if (scratch.width !== canvas.width) scratch.width = canvas.width;
    if (scratch.height !== canvas.height) scratch.height = canvas.height;
    scratchCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height);
    return scratch;
  } catch {
    return null;
  }
}

function releaseScratchCanvas(
  scratchRef: { current: HTMLCanvasElement | null },
  scratchCtxRef: { current: CanvasRenderingContext2D | null },
): void {
  const scratch = scratchRef.current;
  if (scratch) {
    scratch.width = 0;
    scratch.height = 0;
  }
  scratchRef.current = null;
  scratchCtxRef.current = null;
}

/**
 * In-DOM `<canvas>` compositor for Electron `'canvas'` video presentation (`#95`). Receives zero-copy GPU
 * `VideoFrame` instances from the sandboxed preload, draws them onto a cached opaque (`alpha: false`) 2D
 * surface behind React Native Web overlays, snapshots the previous frame across backing resizes to avoid
 * transient black flashes, and guarantees `frame.close()` on every code path.
 */
export function PlayerCanvas({
  engine,
  resizeMode = 'fit',
  visible,
}: PlayerCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const hasPaintedFrameRef = useRef(false);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const off = engine.onFrame?.((frame) => {
      try {
        if (!visibleRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = acquireOpaqueContext(canvas, ctxRef.current);
        if (!ctx) return;
        ctxRef.current = ctx;
        const targetWidth =
          typeof frame.displayWidth === 'number' &&
          Number.isFinite(frame.displayWidth) &&
          frame.displayWidth > 0
            ? frame.displayWidth
            : frame.codedWidth;
        const targetHeight =
          typeof frame.displayHeight === 'number' &&
          Number.isFinite(frame.displayHeight) &&
          frame.displayHeight > 0
            ? frame.displayHeight
            : frame.codedHeight;
        if (
          !Number.isFinite(targetWidth) ||
          !Number.isFinite(targetHeight) ||
          targetWidth <= 0 ||
          targetHeight <= 0
        ) {
          return;
        }
        const needsResize = canvas.width !== targetWidth || canvas.height !== targetHeight;
        const previousSnapshot =
          needsResize && hasPaintedFrameRef.current
            ? capturePreviousFrame(canvas, scratchCanvasRef, scratchCtxRef)
            : null;
        if (canvas.width !== targetWidth) canvas.width = targetWidth;
        if (canvas.height !== targetHeight) canvas.height = targetHeight;
        try {
          ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
          hasPaintedFrameRef.current = true;
          if (!needsResize) {
            const scratch = scratchCanvasRef.current;
            if (scratch && (scratch.width !== 0 || scratch.height !== 0)) {
              scratch.width = 0;
              scratch.height = 0;
            }
          }
        } catch {
          // Restore previous frame scaled into the resized canvas so a transient draw failure never flashes black.
          let restored = false;
          if (previousSnapshot !== null) {
            try {
              ctx.drawImage(previousSnapshot, 0, 0, canvas.width, canvas.height);
              restored = true;
            } catch {
              // Best-effort fallback repaint; finally always releases the incoming frame.
            }
          }
          if (needsResize && !restored) {
            hasPaintedFrameRef.current = false;
          }
        }
      } catch {
        // Ignore transient GPU/context failures; finally always releases the frame.
      } finally {
        try {
          frame.close();
        } catch {
          // Ignore close failures on an already-closed frame.
        }
      }
    });
    return () => {
      off?.();
      clearCanvas(canvasRef.current, ctxRef.current);
      hasPaintedFrameRef.current = false;
      releaseScratchCanvas(scratchCanvasRef, scratchCtxRef);
      ctxRef.current = null;
    };
  }, [engine]);

  useEffect(() => {
    if (!visible) {
      clearCanvas(canvasRef.current, ctxRef.current);
      hasPaintedFrameRef.current = false;
      releaseScratchCanvas(scratchCanvasRef, scratchCtxRef);
    }
  }, [visible]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="player-canvas"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: 'none',
        objectFit: resizeMode === 'fill' ? 'cover' : resizeMode === 'stretch' ? 'fill' : 'contain',
        opacity: visible ? 1 : 0,
      }}
    />
  );
}

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

/**
 * In-DOM `<canvas>` compositor for Electron `'canvas'` video presentation (`#95`). Receives zero-copy GPU
 * `VideoFrame` instances from the sandboxed preload, draws them onto a cached opaque (`alpha: false`) 2D
 * surface behind React Native Web overlays, and guarantees `frame.close()` on every code path.
 */
export function PlayerCanvas({
  engine,
  resizeMode = 'fit',
  visible,
}: PlayerCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
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
          typeof frame.displayWidth === 'number' && frame.displayWidth > 0
            ? frame.displayWidth
            : frame.codedWidth;
        const targetHeight =
          typeof frame.displayHeight === 'number' && frame.displayHeight > 0
            ? frame.displayHeight
            : frame.codedHeight;
        if (targetWidth <= 0 || targetHeight <= 0) return;
        if (canvas.width !== targetWidth) canvas.width = targetWidth;
        if (canvas.height !== targetHeight) canvas.height = targetHeight;
        ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
      } catch {
        // Ignore transient GPU/context draw failures; finally always releases the frame.
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
      ctxRef.current = null;
    };
  }, [engine]);

  useEffect(() => {
    if (!visible) clearCanvas(canvasRef.current, ctxRef.current);
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

import { type ReactElement, useEffect, useRef } from 'react';
import type { DesktopEngine } from './desktop-engine.ts';

/** Props of {@link PlayerCanvas}. */
export interface PlayerCanvasProps {
  engine: DesktopEngine;
  /** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover). */
  resizeMode?: 'fit' | 'fill';
  /** When `false`, incoming frames are closed without drawing and the canvas is cleared. */
  visible: boolean;
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * In-DOM `<canvas>` compositor for Electron `'canvas'` video presentation (`#95`). Receives zero-copy GPU
 * `VideoFrame` instances from the sandboxed preload, draws them behind React Native Web overlays, and guarantees
 * `frame.close()` on every code path.
 */
export function PlayerCanvas({
  engine,
  resizeMode = 'fit',
  visible,
}: PlayerCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const off = engine.onFrame?.((frame) => {
      try {
        if (!visibleRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        if (frame.codedWidth <= 0 || frame.codedHeight <= 0) return;
        if (canvas.width !== frame.codedWidth) canvas.width = frame.codedWidth;
        if (canvas.height !== frame.codedHeight) canvas.height = frame.codedHeight;
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
      clearCanvas(canvasRef.current);
    };
  }, [engine]);

  useEffect(() => {
    if (!visible) clearCanvas(canvasRef.current);
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
        objectFit: resizeMode === 'fill' ? 'cover' : 'contain',
        opacity: visible ? 1 : 0,
      }}
    />
  );
}

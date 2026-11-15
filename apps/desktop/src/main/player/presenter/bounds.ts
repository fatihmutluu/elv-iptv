import type { PlayerArea } from '../../../shared/player-ipc.ts';

/** A rectangle; screen rects are in DIPs unless a name says pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rounds edges, not sizes, so neighbouring rects stay flush; `+ 0` turns `-0` into `0`. */
function roundEdges(left: number, top: number, right: number, bottom: number): Rect {
  const x = Math.round(left) + 0;
  const y = Math.round(top) + 0;
  return {
    x,
    y,
    width: Math.max(1, Math.round(right) - x),
    height: Math.max(1, Math.round(bottom) - y),
  };
}

/**
 * Maps a player area (CSS pixels in the app window's content) to screen DIPs:
 * the content origin plus the area scaled by the page zoom, rounded, at least 1x1.
 */
export function areaToScreen(content: Rect, area: PlayerArea, zoomFactor: number): Rect {
  const left = content.x + area.x * zoomFactor;
  const top = content.y + area.y * zoomFactor;
  return roundEdges(
    left,
    top,
    left + Math.max(0, area.width) * zoomFactor,
    top + Math.max(0, area.height) * zoomFactor,
  );
}

/**
 * The part of a screen rect (DIPs) that lies on a display, in that display's capture thumbnail pixels.
 * Null when the rect misses the display.
 */
export function cropInThumbnail(
  rect: Rect,
  display: Rect,
  thumbnail: { width: number; height: number },
): Rect | null {
  const left = Math.max(rect.x, display.x);
  const top = Math.max(rect.y, display.y);
  const right = Math.min(rect.x + rect.width, display.x + display.width);
  const bottom = Math.min(rect.y + rect.height, display.y + display.height);
  if (right <= left || bottom <= top) return null;
  const sx = thumbnail.width / display.width;
  const sy = thumbnail.height / display.height;
  const crop = roundEdges(
    (left - display.x) * sx,
    (top - display.y) * sy,
    (right - display.x) * sx,
    (bottom - display.y) * sy,
  );
  crop.width = Math.min(crop.width, thumbnail.width - crop.x);
  crop.height = Math.min(crop.height, thumbnail.height - crop.y);
  return crop;
}

/**
 * Maps a screen rect (points, top-left of the primary display) to mpv's macOS `--geometry` units:
 * backing pixels (`scaleFactor`) measured top-down from the display's `workArea` (`NSScreen.visibleFrame`) top-left.
 */
export function macOwnWindowGeometry(dip: Rect, workArea: Rect, scaleFactor: number): Rect {
  const left = (dip.x - workArea.x) * scaleFactor;
  const top = (dip.y - workArea.y) * scaleFactor;
  return roundEdges(
    left,
    top,
    left + Math.max(0, dip.width) * scaleFactor,
    top + Math.max(0, dip.height) * scaleFactor,
  );
}

/** Counts the distinct colours of a BGRA bitmap after reducing each channel to 5 bits (alpha ignored). */
export function countBuckets(bgra: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    seen.add(
      (((bgra[i] ?? 0) >> 3) << 10) | (((bgra[i + 1] ?? 0) >> 3) << 5) | ((bgra[i + 2] ?? 0) >> 3),
    );
  }
  return seen.size;
}

import type { PlayerArea } from '../../../shared/player-ipc.ts';

/** A rectangle; screen rects are in DIPs unless a name says pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fullscreen bounds policy for notched displays without native modesetting (`#269`). */
export type FullscreenMode = 'safe-area' | 'desktop';

/** Display bounds and work area (DIPs) matching Electron's `Display`. */
export interface DisplayBounds {
  readonly bounds: Rect;
  readonly workArea: Rect;
}

/** Rounds edges, not sizes, so neighbouring rects stay flush; `+ 0` turns `-0` into `0`. */
export function roundEdges(left: number, top: number, right: number, bottom: number): Rect {
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
  if (thumbnail.width < 1 || thumbnail.height < 1 || display.width <= 0 || display.height <= 0) {
    return null;
  }
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
  crop.x = Math.min(Math.max(0, crop.x), thumbnail.width - 1);
  crop.y = Math.min(Math.max(0, crop.y), thumbnail.height - 1);
  crop.width = Math.max(1, Math.min(crop.width, thumbnail.width - crop.x));
  crop.height = Math.max(1, Math.min(crop.height, thumbnail.height - crop.y));
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

/**
 * Clamps a DIP rectangle into `container` (at least 1x1), falling back to `container` when the
 * rectangles do not overlap.
 */
function clampRectToBounds(rect: Rect, container: Rect): Rect {
  const left = Math.max(rect.x, container.x);
  const top = Math.max(rect.y, container.y);
  const right = Math.min(rect.x + rect.width, container.x + container.width);
  const bottom = Math.min(rect.y + rect.height, container.y + container.height);
  if (right <= left || bottom <= top) {
    return {
      x: Math.round(container.x) + 0,
      y: Math.round(container.y) + 0,
      width: Math.max(1, Math.round(container.width)),
      height: Math.max(1, Math.round(container.height)),
    };
  }
  return roundEdges(left, top, right, bottom);
}

/**
 * Resolves fullscreen DIP geometry for a display (`#269`): `'safe-area'` stays within `workArea`
 * (respecting notched macOS displays without `CGDisplaySetDisplayMode` modesetting), while
 * `'desktop'` spans full display `bounds`.
 */
export function resolveFullscreenRect(
  rect: Rect,
  display: DisplayBounds,
  mode: FullscreenMode = 'safe-area',
): Rect {
  if (mode === 'desktop') {
    return {
      x: Math.round(display.bounds.x) + 0,
      y: Math.round(display.bounds.y) + 0,
      width: Math.max(1, Math.round(display.bounds.width)),
      height: Math.max(1, Math.round(display.bounds.height)),
    };
  }
  return clampRectToBounds(rect, display.workArea);
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

/**
 * Snaps a windowed content rectangle (DIPs) to `aspectRatio` on the `1 / scaleFactor` physical
 * pixel grid (`1.0`, `1.25`, `1.5`, `2.0` DPR) so `Math.round(dim * scaleFactor)` has zero 1 px
 * letterboxing/cropping mismatch while respecting `minContentSize` (`#332`).
 */
export function lockContentRectToAspect(
  contentRect: Rect,
  aspectRatio: number,
  scaleFactor: number,
  minContentSize: { readonly width: number; readonly height: number },
  preferredAxis: 'width' | 'height' = 'width',
): Rect {
  const x = Math.round(contentRect.x) + 0;
  const y = Math.round(contentRect.y) + 0;
  const minW = Math.max(1, Math.ceil(minContentSize.width));
  const minH = Math.max(1, Math.ceil(minContentSize.height));
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return {
      x,
      y,
      width: Math.max(minW, Math.round(contentRect.width)),
      height: Math.max(minH, Math.round(contentRect.height)),
    };
  }
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const minPhysW = Math.ceil(minW * scale);
  const minPhysH = Math.ceil(minH * scale);

  let baseW = Math.max(minW, Math.round(contentRect.width));
  let baseH = Math.max(minH, Math.round(contentRect.height));
  if (preferredAxis === 'height') {
    baseW = Math.max(minW, Math.round(baseH * aspectRatio));
    if (Math.round(baseW / aspectRatio) < minH || baseW === minW) {
      baseH = Math.max(minH, Math.round(baseW / aspectRatio));
    }
  } else {
    baseH = Math.max(minH, Math.round(baseW / aspectRatio));
    if (baseH === minH && Math.round(minH * aspectRatio) > baseW) {
      baseW = Math.max(minW, Math.round(minH * aspectRatio));
    }
  }

  let best: { width: number; height: number; err: number } | undefined;
  const MAX_SEARCH_DELTA = 32;
  for (let step = 0; step <= MAX_SEARCH_DELTA; step += 1) {
    const deltas = step === 0 ? [0] : [step, -step];
    for (const delta of deltas) {
      let candW: number;
      let candH: number;
      if (preferredAxis === 'height') {
        candH = baseH + delta;
        if (candH < minH) continue;
        const physH = Math.round(candH * scale);
        if (physH < minPhysH) continue;
        const targetPhysW = Math.max(minPhysW, Math.round(physH * aspectRatio));
        candW = Math.max(minW, Math.round(targetPhysW / scale));
      } else {
        candW = baseW + delta;
        if (candW < minW) continue;
        const physW = Math.round(candW * scale);
        if (physW < minPhysW) continue;
        const targetPhysH = Math.max(minPhysH, Math.round(physW / aspectRatio));
        candH = Math.max(minH, Math.round(targetPhysH / scale));
      }
      if (candW < minW || candH < minH) continue;
      const physW = Math.round(candW * scale);
      const physH = Math.round(candH * scale);
      const errH = Math.abs(Math.round(physW / aspectRatio) - physH);
      const errW = Math.abs(Math.round(physH * aspectRatio) - physW);
      const err = errH + errW;
      if (err === 0) {
        return { x, y, width: candW, height: candH };
      }
      if (!best || err < best.err) {
        best = { width: candW, height: candH, err };
      }
    }
  }
  return {
    x,
    y,
    width: best?.width ?? baseW,
    height: best?.height ?? baseH,
  };
}

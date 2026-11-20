import type { FormFactor } from '../form-factor';

/** Active layout orientation driving Portrait vs Landscape container splits. */
export type Orientation = 'portrait' | 'landscape';

/** Dominant user input modality driving focus, hover, and touch targets. */
export type InputModality = 'tv' | 'pointer' | 'touch';

/** Edge safe-area insets in logical points/pixels. */
export interface EdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Responsive rail and grid column counts derived from form factor and orientation. */
export interface ViewportColumns {
  readonly posterRail: number;
  readonly wideRail: number;
  readonly categoryGrid: number;
}

/** Complete resolved viewport snapshot consumed by adaptive UI containers (`useViewport()`). */
export interface ViewportInfo {
  readonly formFactor: FormFactor;
  readonly orientation: Orientation;
  readonly inputModality: InputModality;
  readonly width: number;
  readonly height: number;
  readonly safeArea: EdgeInsets;
  readonly overscan: { readonly x: number; readonly y: number };
  readonly columns: ViewportColumns;
  /**
   * Logical 10-foot scale normalizing Android TV (`960x540dp`) and tvOS (`1920x1080pt`) onto a shared
   * baseline (`#281`). Always `1` on phone, tablet, and desktop.
   */
  readonly tvScale: number;
}

/** Optional overrides accepted by `ViewportProvider` (used by tests and `pnpm dev:ui` preview). */
export interface ViewportOverride {
  readonly formFactor?: FormFactor;
  readonly orientation?: Orientation;
  readonly inputModality?: InputModality;
  readonly width?: number;
  readonly height?: number;
  readonly safeArea?: Partial<EdgeInsets>;
  readonly overscanEnabled?: boolean;
}

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const TV_REFERENCE_WIDTH = 1920;
const TV_OVERSCAN_RATIO = 0.05;
const TABLET_MIN_SHORT_EDGE_DP = 600;

function classifyFormFactor(input: {
  isTV: boolean;
  os: string;
  width: number;
  height: number;
}): FormFactor {
  if (input.isTV) return 'tv';
  if (input.os === 'web') return 'desktop';
  if (Math.min(input.width, input.height) >= TABLET_MIN_SHORT_EDGE_DP) return 'tablet';
  return 'phone';
}

function defaultModality(formFactor: FormFactor): InputModality {
  if (formFactor === 'tv') return 'tv';
  if (formFactor === 'desktop') return 'pointer';
  return 'touch';
}

function defaultOrientation(formFactor: FormFactor, width: number, height: number): Orientation {
  if (formFactor === 'tv') return 'landscape';
  return height > width ? 'portrait' : 'landscape';
}

function resolveColumns(
  formFactor: FormFactor,
  orientation: Orientation,
  width: number,
): ViewportColumns {
  if (orientation === 'portrait') {
    const wideRail = formFactor === 'tablet' ? 2.3 : 1.2;
    return { posterRail: 3.5, wideRail, categoryGrid: 3 };
  }
  if (formFactor === 'desktop' && width > 0 && width < 760) {
    return { posterRail: 3.5, wideRail: 2.2, categoryGrid: 3 };
  }
  return { posterRail: 5.5, wideRail: 3.3, categoryGrid: 5 };
}

/** Resolves a complete {@link ViewportInfo} snapshot from raw platform metrics and optional overrides. */
export function resolveViewport(input: {
  isTV: boolean;
  os: string;
  width: number;
  height: number;
  override?: ViewportOverride;
}): ViewportInfo {
  const safeWidth = Number.isFinite(input.width) && input.width > 0 ? input.width : 1280;
  const safeHeight = Number.isFinite(input.height) && input.height > 0 ? input.height : 720;
  const override = input.override;

  const width =
    override?.width !== undefined && Number.isFinite(override.width) && override.width > 0
      ? override.width
      : safeWidth;
  const height =
    override?.height !== undefined && Number.isFinite(override.height) && override.height > 0
      ? override.height
      : safeHeight;

  const formFactor =
    override?.formFactor ?? classifyFormFactor({ isTV: input.isTV, os: input.os, width, height });
  const orientation = override?.orientation ?? defaultOrientation(formFactor, width, height);
  const inputModality = override?.inputModality ?? defaultModality(formFactor);

  const safeArea: EdgeInsets = {
    top: override?.safeArea?.top ?? ZERO_INSETS.top,
    right: override?.safeArea?.right ?? ZERO_INSETS.right,
    bottom: override?.safeArea?.bottom ?? ZERO_INSETS.bottom,
    left: override?.safeArea?.left ?? ZERO_INSETS.left,
  };

  const applyOverscan = override?.overscanEnabled ?? formFactor === 'tv';
  const overscan = applyOverscan
    ? {
        x: Math.round(width * TV_OVERSCAN_RATIO),
        y: Math.round(height * TV_OVERSCAN_RATIO),
      }
    : { x: 0, y: 0 };

  const tvScale =
    formFactor === 'tv'
      ? Math.round(Math.min(1.5, Math.max(0.5, width / TV_REFERENCE_WIDTH)) * 1000) / 1000
      : 1;

  return {
    formFactor,
    orientation,
    inputModality,
    width,
    height,
    safeArea,
    overscan,
    columns: resolveColumns(formFactor, orientation, width),
    tvScale,
  };
}

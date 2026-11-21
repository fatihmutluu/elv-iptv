import type { ViewportOverride } from '@elv/ui-kit';

/** Supported device simulation frames in the dev-only UI Workbench. */
export type WorkbenchDeviceId =
  | 'tv'
  | 'phone-portrait'
  | 'phone-landscape'
  | 'tablet-portrait'
  | 'tablet-landscape'
  | 'desktop';

/** Active Workbench view mode. */
export type WorkbenchMode = 'gallery' | 'app';

/** Device preset metadata consumed by the Workbench frame and toolbar. */
export interface WorkbenchDevicePreset {
  readonly id: WorkbenchDeviceId;
  readonly label: string;
  readonly shortLabel: string;
  readonly frameWidth: number | 'fluid';
  readonly frameHeight: number | 'fluid';
  readonly viewport: ViewportOverride;
}

const DESKTOP_PRESET: WorkbenchDevicePreset = {
  id: 'desktop',
  label: 'Desktop',
  shortLabel: 'PC',
  frameWidth: 'fluid',
  frameHeight: 'fluid',
  viewport: {
    formFactor: 'desktop',
    orientation: 'landscape',
    inputModality: 'pointer',
  },
};

/** Ordered list of Workbench device simulation frames (`UI_UX_PHILOSOPHY.md` §3). */
export const WORKBENCH_DEVICES: readonly WorkbenchDevicePreset[] = [
  {
    id: 'tv',
    label: 'Living Room TV',
    shortLabel: 'TV',
    frameWidth: 1280,
    frameHeight: 720,
    viewport: {
      formFactor: 'tv',
      orientation: 'landscape',
      inputModality: 'tv',
      width: 1280,
      height: 720,
    },
  },
  {
    id: 'phone-portrait',
    label: 'Phone Portrait',
    shortLabel: 'Phone P',
    frameWidth: 393,
    frameHeight: 852,
    viewport: {
      formFactor: 'phone',
      orientation: 'portrait',
      inputModality: 'touch',
      width: 393,
      height: 852,
      safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
    },
  },
  {
    id: 'phone-landscape',
    label: 'Phone Landscape',
    shortLabel: 'Phone L',
    frameWidth: 852,
    frameHeight: 393,
    viewport: {
      formFactor: 'phone',
      orientation: 'landscape',
      inputModality: 'touch',
      width: 852,
      height: 393,
      safeArea: { top: 0, right: 59, bottom: 21, left: 59 },
    },
  },
  {
    id: 'tablet-portrait',
    label: 'Tablet Portrait',
    shortLabel: 'Tab P',
    frameWidth: 834,
    frameHeight: 1194,
    viewport: {
      formFactor: 'tablet',
      orientation: 'portrait',
      inputModality: 'touch',
      width: 834,
      height: 1194,
      safeArea: { top: 24, right: 0, bottom: 20, left: 0 },
    },
  },
  {
    id: 'tablet-landscape',
    label: 'Tablet Landscape',
    shortLabel: 'Tab L',
    frameWidth: 1194,
    frameHeight: 834,
    viewport: {
      formFactor: 'tablet',
      orientation: 'landscape',
      inputModality: 'touch',
      width: 1194,
      height: 834,
      safeArea: { top: 24, right: 0, bottom: 20, left: 0 },
    },
  },
  DESKTOP_PRESET,
];

/** Looks up a {@link WorkbenchDevicePreset} by id, falling back to `desktop`. */
export function getWorkbenchDevice(id: WorkbenchDeviceId): WorkbenchDevicePreset {
  return WORKBENCH_DEVICES.find((d) => d.id === id) ?? DESKTOP_PRESET;
}

/** Top-level device family shown in the 4-way Workbench switcher (`TV | PC | Tablet | Phone`). */
export type WorkbenchDeviceFamily = 'tv' | 'desktop' | 'tablet' | 'phone';

/** Maps a concrete {@link WorkbenchDeviceId} to its 4-way family switcher bucket. */
export function deviceFamilyOf(id: WorkbenchDeviceId): WorkbenchDeviceFamily {
  if (id === 'tv') return 'tv';
  if (id === 'desktop') return 'desktop';
  if (id === 'tablet-portrait' || id === 'tablet-landscape') return 'tablet';
  return 'phone';
}

/** Toggles Portrait <-> Landscape for phone and tablet presets; leaves TV and Desktop unchanged. */
export function toggleDeviceOrientation(id: WorkbenchDeviceId): WorkbenchDeviceId {
  switch (id) {
    case 'phone-portrait':
      return 'phone-landscape';
    case 'phone-landscape':
      return 'phone-portrait';
    case 'tablet-portrait':
      return 'tablet-landscape';
    case 'tablet-landscape':
      return 'tablet-portrait';
    default:
      return id;
  }
}

/** Resolved display dimensions for a device frame scaled to fit the Workbench stage. */
export interface FittedFrame {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly fitPercent: number;
}

/**
 * Fits a target device frame (`frameWidth × frameHeight`) inside the available stage box
 * (`stageWidth × stageHeight`) while preserving aspect ratio and never scaling above `1.0`.
 */
export function computeFittedFrame(opts: {
  frameWidth: number;
  frameHeight: number;
  stageWidth: number;
  stageHeight: number;
  paddingX?: number;
  paddingY?: number;
}): FittedFrame {
  const availW = Math.max(160, opts.stageWidth - (opts.paddingX ?? 48));
  const availH = Math.max(160, opts.stageHeight - (opts.paddingY ?? 72));
  const scale = Math.min(1, availW / opts.frameWidth, availH / opts.frameHeight);
  return {
    width: Math.round(opts.frameWidth * scale),
    height: Math.round(opts.frameHeight * scale),
    scale,
    fitPercent: Math.round(scale * 100),
  };
}

/**
 * Decides whether the desktop renderer boots the dev-only UI Workbench or the regular desktop app.
 * Production builds (`isDev === false`) and `--elv-gate=` launches (`hasGate === true`) ALWAYS
 * return `false`. In development (`isDev === true`), running in a plain browser
 * (`!hasElectronBridge`) opens the Workbench automatically; inside dev Electron, `?workbench=1`
 * opts in explicitly.
 */
export function shouldMountWorkbench(opts: {
  isDev: boolean;
  hasGate?: boolean;
  hasElectronBridge: boolean;
  search?: string;
}): boolean {
  if (!opts.isDev || opts.hasGate) return false;
  if (!opts.hasElectronBridge) return true;
  if (!opts.search) return false;
  const params = new URLSearchParams(opts.search);
  return params.get('workbench') === '1';
}

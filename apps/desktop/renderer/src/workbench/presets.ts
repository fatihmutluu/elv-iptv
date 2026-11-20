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
  label: 'Desktop Fluid',
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
    label: 'TV 16:9 (10-Foot)',
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
    frameWidth: 390,
    frameHeight: 844,
    viewport: {
      formFactor: 'phone',
      orientation: 'portrait',
      inputModality: 'touch',
      width: 390,
      height: 844,
      safeArea: { top: 44, right: 0, bottom: 24, left: 0 },
    },
  },
  {
    id: 'phone-landscape',
    label: 'Phone Landscape',
    shortLabel: 'Phone L',
    frameWidth: 844,
    frameHeight: 390,
    viewport: {
      formFactor: 'phone',
      orientation: 'landscape',
      inputModality: 'touch',
      width: 844,
      height: 390,
      safeArea: { top: 0, right: 32, bottom: 16, left: 32 },
    },
  },
  {
    id: 'tablet-portrait',
    label: 'Tablet Portrait',
    shortLabel: 'Tab P',
    frameWidth: 768,
    frameHeight: 1024,
    viewport: {
      formFactor: 'tablet',
      orientation: 'portrait',
      inputModality: 'touch',
      width: 768,
      height: 1024,
      safeArea: { top: 24, right: 0, bottom: 20, left: 0 },
    },
  },
  {
    id: 'tablet-landscape',
    label: 'Tablet Landscape',
    shortLabel: 'Tab L',
    frameWidth: 1024,
    frameHeight: 768,
    viewport: {
      formFactor: 'tablet',
      orientation: 'landscape',
      inputModality: 'touch',
      width: 1024,
      height: 768,
      safeArea: { top: 24, right: 0, bottom: 16, left: 0 },
    },
  },
  DESKTOP_PRESET,
];

/** Looks up a {@link WorkbenchDevicePreset} by id, falling back to `desktop`. */
export function getWorkbenchDevice(id: WorkbenchDeviceId): WorkbenchDevicePreset {
  return WORKBENCH_DEVICES.find((d) => d.id === id) ?? DESKTOP_PRESET;
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

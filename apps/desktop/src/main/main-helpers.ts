import { app, type BrowserWindow, dialog, type NativeImage, nativeImage } from 'electron';
import { mergeGateLine, type VideoSampler } from './gate.ts';
import type { MpvEngine } from './player/engine.ts';
import { createTaskbarIconPngs, type TaskbarIcons } from './taskbar-controls.ts';

let cachedTaskbarIcons: TaskbarIcons<NativeImage> | undefined;

/** Lazily builds and caches Windows taskbar thumb-bar PNG icons. */
export function getTaskbarIcons(): TaskbarIcons<NativeImage> {
  if (!cachedTaskbarIcons) {
    const pngs = createTaskbarIconPngs();
    cachedTaskbarIcons = {
      previous: nativeImage.createFromBuffer(pngs.previous),
      play: nativeImage.createFromBuffer(pngs.play),
      pause: nativeImage.createFromBuffer(pngs.pause),
      next: nativeImage.createFromBuffer(pngs.next),
    };
  }
  return cachedTaskbarIcons;
}

/** Clones readonly file-dialog filters into mutable arrays required by Electron's dialog API. */
export function cloneDialogFilters(
  filters: readonly { readonly name: string; readonly extensions: readonly string[] }[],
): { name: string; extensions: string[] }[] {
  return filters.map((f) => ({ name: f.name, extensions: [...f.extensions] }));
}

/** Opens a native file dialog parented to `win` when alive, or unparented otherwise. */
export function showOpenDialogFor(
  win: BrowserWindow | undefined,
  options: {
    readonly properties: readonly string[];
    readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  },
) {
  const opts = {
    properties: [...options.properties] as Electron.OpenDialogOptions['properties'],
    filters: cloneDialogFilters(options.filters),
  };
  return win && !win.isDestroyed() ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}

/** Prints the merged gate report line with main-process measurements and quits. */
export async function printGateLine(
  line: string,
  engine: MpvEngine | undefined,
  samplers: WeakMap<MpvEngine, VideoSampler>,
): Promise<void> {
  const sampler = engine ? samplers.get(engine) : undefined;
  if (!engine || !sampler) {
    process.stderr.write('gate: no engine or sampler for the sender of the report\n');
    app.quit();
    return;
  }
  const sample = await sampler.result();
  const merged = mergeGateLine(line, {
    mpvSpawns: engine.spawns,
    loadMode: engine.loadMode,
    presenter: engine.presenterKind,
    videoVisible: sample.videoVisible,
    distinct: sample.distinct,
    coalesceMaxMs: Math.round(engine.maxHoldMs),
  });
  if (merged === null)
    process.stderr.write('gate: the report line was refused (malformed or carries an address)\n');
  else process.stdout.write(`${merged}\n`);
  app.quit();
}

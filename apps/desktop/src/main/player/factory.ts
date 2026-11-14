import type { BrowserWindow } from 'electron';
import type { PlayerUiEvent } from '../../shared/player-ipc.ts';
import { createMpvEngine, type LoadMode, type MpvEngine } from './engine.ts';
import { launchArgs } from './mpv/options.ts';
import { spawnMpv } from './mpv/process.ts';
import { choosePresenter } from './presenter/choose.ts';
import { createPresenter } from './presenter/create.ts';
import type { MpvRuntimePaths } from './runtime-path.ts';

/** What `createEngineFor` needs besides the window. */
export interface EngineFactoryDeps {
  runtime: MpvRuntimePaths;
  platform: NodeJS.Platform;
  loadMode: LoadMode;
  /** Recorded launcher pids, swept at the next start if the app crashes (`<userData>/mpv-pids.json`). */
  pidFile: string;
  /** Presentation events for the window's renderer. */
  onUi(event: PlayerUiEvent): void;
}

/**
 * Builds the mpv engine for an app window with the platform's presenter. mpv and the video surface start at the
 * engine's `start()`, which the IPC layer calls after subscribing, so the first `surface` event is not lost.
 */
export async function createEngineFor(
  owner: BrowserWindow,
  deps: EngineFactoryDeps,
): Promise<MpvEngine> {
  const presenter = createPresenter(choosePresenter(deps.platform), owner, deps.platform);
  const engine = createMpvEngine({
    spawn: (args, signal) =>
      spawnMpv({
        executable: deps.runtime.executable,
        args,
        platform: deps.platform,
        parentPid: process.pid,
        signal,
        pidFile: deps.pidFile,
      }),
    presenter,
    baseArgs: launchArgs({
      inputConf: deps.runtime.inputConf,
      presenterArgs: [],
      transportArgs: [],
    }),
    loadMode: deps.loadMode,
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    onUi: deps.onUi,
    deferStart: true,
  });
  deps.onUi({ type: 'presenter', kind: presenter.kind, coversArea: presenter.coversArea });
  return engine;
}

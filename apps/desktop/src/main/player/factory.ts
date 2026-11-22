import { dirname, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { HwdecProfile, PlayerUiEvent, PresenterKind } from '../../shared/player-ipc.ts';
import { createMpvEngine, type LoadMode, type MpvEngine } from './engine.ts';
import { launchArgs } from './mpv/options.ts';
import { spawnMpv } from './mpv/process.ts';
import {
  createFileReadaheadPersistence,
  createReadaheadTierStore,
  type ReadaheadTierStore,
} from './mpv/readahead.ts';
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
  /** Engine identifier used by the `'canvas'` presenter to route shared textures to the renderer. */
  engineId?: string;
  /** Optional explicit presenter kind overriding the platform default (`ELV_DESKTOP_PRESENTER`). */
  presenterOverride?: PresenterKind;
  /** Optional initial hardware decoding profile (defaults to `'auto-safe'`). */
  hwdec?: HwdecProfile;
  /** True only when using mpv's render-context API (defaults to `presenter.kind === 'canvas'`). */
  renderContext?: boolean;
  /** Optional persistent adaptive readahead tier store (defaults to `<userData>/mpv-readahead.json`). */
  readaheadStore?: ReadaheadTierStore;
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
  const kind = choosePresenter(deps.platform, deps.presenterOverride);
  const presenter = createPresenter(
    kind,
    owner,
    deps.platform,
    deps.engineId === undefined ? undefined : { engineId: deps.engineId },
  );
  const renderContext = deps.renderContext ?? presenter.kind === 'canvas';
  const readaheadStore =
    deps.readaheadStore ??
    createReadaheadTierStore({
      persistence: createFileReadaheadPersistence(
        join(dirname(deps.pidFile), 'mpv-readahead.json'),
      ),
    });
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
      platform: deps.platform,
      ...(deps.hwdec === undefined ? {} : { hwdec: deps.hwdec }),
      renderContext,
    }),
    loadMode: deps.loadMode,
    platform: deps.platform,
    readaheadStore,
    now: () => performance.now(),
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

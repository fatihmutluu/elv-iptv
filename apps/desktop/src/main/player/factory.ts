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
import { type CreatePresenterOptions, createPresenter } from './presenter/create.ts';
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
  /** Optional sandbox-safe root directory for ephemeral VOD disk cache sessions (`#350`). */
  vodCacheRoot?: string;
  /** Optional dynamic Multi-View tile count for the owning window (`>= 2` disables VOD disk caching, `#350`). */
  getMultiViewTileCount?: () => number;
  /** Optional macOS `[NSScreen screensHaveSeparateSpaces]` query for multi-monitor fullscreen guard (`#301`). */
  screensHaveSeparateSpaces?: () => boolean;
  /** Override for Electron's `process.mas` flag (Mac App Store App Sandbox blocks cross-process `IOSurfaceLookup`). */
  isMas?: boolean;
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
  const isMas = deps.isMas ?? Boolean((process as NodeJS.Process & { mas?: boolean }).mas);
  const requestedKind = choosePresenter(deps.platform, deps.presenterOverride);
  const kind: PresenterKind =
    deps.platform === 'darwin' &&
    requestedKind === 'canvas' &&
    (isMas || !deps.runtime.canvasExecutable || !deps.runtime.ioSurfaceAddon)
      ? 'own-window'
      : requestedKind;
  const ioSurfaceAddon = kind === 'canvas' ? deps.runtime.ioSurfaceAddon : undefined;
  const emitFullscreen = (fullscreen: boolean): void => {
    deps.onUi({ type: 'fullscreen-changed', fullscreen });
  };
  const presenterOpts: CreatePresenterOptions | undefined =
    deps.engineId !== undefined ||
    ioSurfaceAddon !== undefined ||
    deps.screensHaveSeparateSpaces !== undefined
      ? {
          ...(deps.engineId !== undefined ? { engineId: deps.engineId } : {}),
          ...(ioSurfaceAddon !== undefined ? { ioSurfaceAddon } : {}),
          ...(deps.screensHaveSeparateSpaces !== undefined
            ? {
                screensHaveSeparateSpaces: deps.screensHaveSeparateSpaces,
                onFullscreenChange: emitFullscreen,
              }
            : {}),
        }
      : undefined;
  const presenter = createPresenter(kind, owner, deps.platform, presenterOpts);
  const executable =
    kind === 'canvas' && deps.runtime.canvasExecutable
      ? deps.runtime.canvasExecutable
      : deps.runtime.executable;
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
        executable,
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
      ...(deps.runtime.fontsDir === undefined ? {} : { fontsDir: deps.runtime.fontsDir }),
      renderContext,
    }),
    loadMode: deps.loadMode,
    platform: deps.platform,
    readaheadStore,
    ...(deps.vodCacheRoot === undefined ? {} : { vodCacheRoot: deps.vodCacheRoot }),
    ...(deps.getMultiViewTileCount === undefined
      ? {}
      : { getMultiViewTileCount: deps.getMultiViewTileCount }),
    now: () => performance.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    onUi: deps.onUi,
    deferStart: true,
  });
  deps.onUi({ type: 'presenter', kind: presenter.kind, coversArea: presenter.coversArea });
  if (
    typeof owner.on === 'function' &&
    typeof owner.removeListener === 'function' &&
    typeof owner.isFullScreen === 'function'
  ) {
    const onEnterFullScreen = (): void => emitFullscreen(true);
    const onLeaveFullScreen = (): void => emitFullscreen(false);
    owner.on('enter-full-screen', onEnterFullScreen);
    owner.on('leave-full-screen', onLeaveFullScreen);
    if (
      owner.isFullScreen() ||
      (typeof owner.isSimpleFullScreen === 'function' && owner.isSimpleFullScreen())
    ) {
      emitFullscreen(true);
    }
    const baseRelease = engine.release;
    let cleanedUp = false;
    engine.release = () => {
      if (!cleanedUp) {
        cleanedUp = true;
        if (typeof owner.isDestroyed !== 'function' || !owner.isDestroyed()) {
          owner.removeListener('enter-full-screen', onEnterFullScreen);
          owner.removeListener('leave-full-screen', onLeaveFullScreen);
        }
      }
      baseRelease();
    };
  }
  return engine;
}

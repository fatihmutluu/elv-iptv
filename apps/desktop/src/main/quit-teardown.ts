/** Minimal disposable resource cleaned up on Electron `will-quit`. */
export interface QuitDisposable {
  dispose(): unknown;
}

/** Minimal destroyable resource (e.g. system tray) cleaned up on Electron `will-quit`. */
interface QuitDestroyable {
  destroy(): void;
}

/** Mutable resource bag and static hooks managed by {@link createQuitTeardown}. */
export interface QuitTeardownDeps {
  playerIpc?: (() => void) | undefined;
  catalogIpc?: (() => void) | undefined;
  artworkIpc?: (() => void) | undefined;
  windowIpc?: (() => void) | undefined;
  sourcesIpc?: (() => void) | undefined;
  tray?: QuitDestroyable | undefined;
  popout?: QuitDisposable | undefined;
  lanPairing?: QuitDisposable | undefined;
  diagnosticsIpc?: (() => void) | undefined;
  errorTelemetry?: (() => void) | undefined;
  syncIpc?: (() => void) | undefined;
  updaterIpc?: (() => void) | undefined;
  downloadsIpc?: (() => void) | undefined;
  downloadManager?: QuitDisposable | undefined;
  mediaBridge?: QuitDisposable | undefined;
  readonly windowBoundsControllers: Set<QuitDisposable>;
  readonly aspectRatioLockControllers: Map<unknown, QuitDisposable>;
  artworkCache?: QuitDisposable | undefined;
  readonly displayRefresh: { restoreAll(): void };
  readonly powerBlocker: { releaseAll(): void };
  readonly clearRefs?: () => void;
  readonly log?: (line: string) => void;
}

/** Idempotent shutdown teardown controller invoked strictly once on Electron `will-quit`. */
export interface QuitTeardownController {
  /** Awaits bounded async flushes (extra tasks + downloadManager + artworkCache) before exit. */
  flushBeforeQuit(extraTasks?: readonly (() => unknown)[], timeoutMs?: number): Promise<void>;
  /** Runs teardown if not yet executed and returns `true`; subsequent calls return `false`. */
  run(): boolean;
  /** Returns `true` once {@link run} has executed. */
  hasRun(): boolean;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2_500;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Creates a strictly idempotent `will-quit` teardown controller that disposes every desktop main
 * subsystem once without letting a failure in one disposer skip remaining cleanup hooks.
 */
export function createQuitTeardown(deps: QuitTeardownDeps): QuitTeardownController {
  let ran = false;

  const runSafe = (label: string, fn: () => unknown): void => {
    try {
      const result = fn();
      if (isThenable(result)) {
        void Promise.resolve(result).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          deps.log?.(`will-quit: ${label} disposal rejected (${msg})`);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.(`will-quit: ${label} disposal failed (${msg})`);
    }
  };

  return {
    hasRun: () => ran,
    async flushBeforeQuit(extraTasks = [], timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
      const tasks: Promise<unknown>[] = [];
      const enqueue = (fn: () => unknown): void => {
        try {
          const value = fn();
          if (value !== undefined) tasks.push(Promise.resolve(value));
        } catch (err) {
          tasks.push(Promise.reject(err));
        }
      };
      for (const task of extraTasks) enqueue(task);
      const dm = deps.downloadManager;
      if (dm) enqueue(() => dm.dispose());
      const art = deps.artworkCache;
      if (art) enqueue(() => art.dispose());
      if (tasks.length === 0) return;

      const allSettled = Promise.allSettled(tasks).then(() => undefined);
      if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
        await allSettled;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          allSettled,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
              (timer as { unref?: () => void }).unref?.();
            }
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    run() {
      if (ran) return false;
      ran = true;

      const playerIpc = deps.playerIpc;
      deps.playerIpc = undefined;
      if (playerIpc) runSafe('playerIpc', playerIpc);

      const catalogIpc = deps.catalogIpc;
      deps.catalogIpc = undefined;
      if (catalogIpc) runSafe('catalogIpc', catalogIpc);

      const artworkIpc = deps.artworkIpc;
      deps.artworkIpc = undefined;
      if (artworkIpc) runSafe('artworkIpc', artworkIpc);

      const windowIpc = deps.windowIpc;
      deps.windowIpc = undefined;
      if (windowIpc) runSafe('windowIpc', windowIpc);

      const sourcesIpc = deps.sourcesIpc;
      deps.sourcesIpc = undefined;
      if (sourcesIpc) runSafe('sourcesIpc', sourcesIpc);

      const tray = deps.tray;
      deps.tray = undefined;
      if (tray) runSafe('tray', () => tray.destroy());

      const popout = deps.popout;
      deps.popout = undefined;
      if (popout) runSafe('popout', () => popout.dispose());

      const lanPairing = deps.lanPairing;
      deps.lanPairing = undefined;
      if (lanPairing) runSafe('lanPairing', () => lanPairing.dispose());

      const diagnosticsIpc = deps.diagnosticsIpc;
      deps.diagnosticsIpc = undefined;
      if (diagnosticsIpc) runSafe('diagnosticsIpc', diagnosticsIpc);

      const errorTelemetry = deps.errorTelemetry;
      deps.errorTelemetry = undefined;
      if (errorTelemetry) runSafe('errorTelemetry', errorTelemetry);

      const syncIpc = deps.syncIpc;
      deps.syncIpc = undefined;
      if (syncIpc) runSafe('syncIpc', syncIpc);

      const updaterIpc = deps.updaterIpc;
      deps.updaterIpc = undefined;
      if (updaterIpc) runSafe('updaterIpc', updaterIpc);

      const downloadsIpc = deps.downloadsIpc;
      deps.downloadsIpc = undefined;
      if (downloadsIpc) runSafe('downloadsIpc', downloadsIpc);

      const downloadManager = deps.downloadManager;
      deps.downloadManager = undefined;
      if (downloadManager) runSafe('downloadManager', () => downloadManager.dispose());

      const mediaBridge = deps.mediaBridge;
      deps.mediaBridge = undefined;
      if (mediaBridge) runSafe('mediaBridge', () => mediaBridge.dispose());

      const boundsList = [...deps.windowBoundsControllers];
      deps.windowBoundsControllers.clear();
      for (const ctl of boundsList) {
        runSafe('windowBoundsController', () => ctl.dispose());
      }

      const aspectList = [...deps.aspectRatioLockControllers.values()];
      deps.aspectRatioLockControllers.clear();
      for (const ctl of aspectList) {
        runSafe('aspectRatioLockController', () => ctl.dispose());
      }

      const artworkCache = deps.artworkCache;
      deps.artworkCache = undefined;
      if (artworkCache) runSafe('artworkCache', () => artworkCache.dispose());

      runSafe('displayRefresh', () => deps.displayRefresh.restoreAll());
      runSafe('powerBlocker', () => deps.powerBlocker.releaseAll());
      if (deps.clearRefs) runSafe('clearRefs', deps.clearRefs);

      return true;
    },
  };
}

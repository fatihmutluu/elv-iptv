import { rmSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import * as nodeNet from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SecretStore } from '@elv/domain';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MessageChannelMain,
  type MessagePortMain,
  type NativeImage,
  nativeImage,
  net,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  Tray,
  utilityProcess,
  type WebContents,
} from 'electron';
import { ARTWORK_PROTOCOL_SCHEME } from '../shared/artwork-ipc.ts';
import { CATALOG_CHANNELS } from '../shared/catalog-ipc.ts';
import type { PresenterKind } from '../shared/player-ipc.ts';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import { APP_ORIGIN, APP_SCHEME } from './app-protocol.ts';
import { createDesktopArtworkCache, registerArtworkIpc } from './artwork-cache.ts';
import { serveArtworkRequest } from './artwork-protocol.ts';
import { attachBrowserBackGuard } from './browser-back.ts';
import { type CatalogCoordinator, createCatalogCoordinator } from './catalog/coordinator.ts';
import { parseDevSeedEnv, runDesktopDevSeedOnce } from './catalog/dev-seed.ts';
import { registerCatalogIpc, registerCatalogQuitHandler } from './catalog/ipc.ts';
import {
  createAesGcmTestCipher,
  createEncryptedFileSecretStore,
  createSafeStorageCipher,
} from './catalog/secret-store.ts';
import { parseDevServerUrl } from './dev-server.ts';
import { registerDiagnosticsIpc } from './diagnostics-ipc.ts';
import { createDesktopDownloadDeps } from './downloads/desktop-download-deps.ts';
import { createDesktopDownloadManager } from './downloads/download-manager.ts';
import { registerDownloadsIpc } from './downloads/ipc.ts';
import { getManagedDownloadsDir } from './downloads/managed-path.ts';
import {
  createVideoSampler,
  GATE_PLAYING_LINE,
  mergeGateLine,
  onFirstPlaying,
  parseGateFlag,
  sampleRect,
  type VideoSampler,
} from './gate.ts';
import { registerLanPairingIpc } from './lan-pairing-ipc.ts';
import { createDesktopLogger } from './log.ts';
import {
  createMacOsMediaBridge,
  loadMacOsMediaAddon,
  queryMacScreensHaveSeparateSpaces,
} from './macos-media.ts';
import { createMprisBridge } from './mpris/mpris-bridge.ts';
import { createPendingPairDeepLinkQueue, extractPairDeepLinkFromArgv } from './pair-deep-link.ts';
import { createDesktopDisplayRefreshController } from './player/display-refresh.ts';
import type { MpvEngine } from './player/engine.ts';
import { createEngineFor } from './player/factory.ts';
import { registerPlayerIpc, type WebContentsLike } from './player/ipc.ts';
import { sweepLeftovers, systemSweepDeps } from './player/mpv/pid-sweep.ts';
import { purgeOrphanedVodCacheDirs, resolveVodCacheRoot } from './player/mpv/vod-cache.ts';
import { createPowerBlocker } from './player/power-blocker.ts';
import { choosePresenter, parsePresenterOverride } from './player/presenter/choose.ts';
import { sampleArea } from './player/presenter/visible.ts';
import { mpvRuntimePaths, resolveMacMediaAddonPath } from './player/runtime-path.ts';
import { createSubtitleFilePicker } from './player/subtitle-fetch.ts';
import {
  createPlayerWindowHostHooks,
  schedulePostPaintMpvWarmUp,
} from './player/window-lifecycle.ts';
import {
  createPendingPlaylistQueue,
  extractPlaylistPathsFromArgv,
  readValidatedPlaylistFile,
} from './playlist-open.ts';
import {
  createPopoutWindowController,
  POPOUT_STATE_FILENAME,
  type PopoutWindowController,
} from './popout-window.ts';
import { createQuitTeardown, type QuitTeardownDeps } from './quit-teardown.ts';
import { lockDownSession, lockDownWebContents } from './security.ts';
import { type ServeDeps, serveAppRequest } from './serve-app.ts';
import { createShellPrefsController, type ShellPrefsController } from './shell-prefs.ts';
import { focusWindow, startSingleInstance } from './single-instance.ts';
import { registerSourcesIpc } from './sources-ipc.ts';
import { createDesktopCatalogSnapshotBridge } from './sync/desktop-catalog-snapshot.ts';
import {
  attachMainErrorTelemetry,
  attachWindowSyncLifecycle,
  bindSyncServerUrlToCatalogCoordinator,
  collectDesktopDeviceProfile,
} from './sync/main-lifecycle.ts';
import { registerSyncIpc } from './sync/sync-ipc-handlers.ts';
import { createDesktopSyncService, type DesktopSyncService } from './sync/sync-service.ts';
import {
  createTaskbarController,
  createTaskbarIconPngs,
  type TaskbarIcons,
} from './taskbar-controls.ts';
import { createTrailerWindowController } from './trailer-window.ts';
import {
  createTrayController,
  createTrayIconPng,
  restoreWindowFromTray,
  type TrayController,
} from './tray.ts';
import {
  createWindowAspectRatioLockController,
  createWindowBoundsController,
  loadWindowState,
  orderedDisplays,
  type WindowAspectRatioLockController,
  type WindowBoundsController,
} from './window-bounds.ts';
import { registerWindowIpc } from './window-ipc.ts';
import { attachRendererCrashRecovery, buildWindowOptions, WINDOW_TITLE } from './window-options.ts';

declare const __ELV_DEV_SEED__: boolean;
declare const __ELV_SYNC_SERVER_URL__: string;

try {
  nodeModule.enableCompileCache?.();
} catch {
  // Compile cache is optional on runtimes without support.
}
try {
  nodeNet.setDefaultAutoSelectFamilyAttemptTimeout?.(2_500);
} catch {
  // Best-effort Happy Eyeballs timeout boost for VPN/dual-stack links.
}

const rendererDir = join(__dirname, '..', 'renderer');
const runtimeEnv = () => ({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  platform: process.platform,
  arch: process.arch,
});

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,HardwareMediaKeyHandling');
}

const gateQuery = parseGateFlag(process.argv, app.isPackaged);
const pendingPlaylists = createPendingPlaylistQueue();
const pendingPairDeepLinks = createPendingPairDeepLinkQueue();
let hasLock = false;
let appInitialized = false;
let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let shellPrefs: ShellPrefsController | undefined;
let trayController: TrayController | undefined;
let popoutController: PopoutWindowController | undefined;
const enqueuePlaylistPaths = (paths: readonly string[]): void => {
  for (const p of paths) {
    void readValidatedPlaylistFile(p)
      .then((file) => (file ? pendingPlaylists.enqueue(file) : undefined))
      .catch(() => undefined);
  }
};
const senderWindow = (sender: unknown): BrowserWindow | null =>
  BrowserWindow.fromWebContents(sender as WebContents);
const allWebContents = (): WebContents[] => BrowserWindow.getAllWindows().map((w) => w.webContents);
const resolveActivePresenterKind = (): PresenterKind => {
  const requested = choosePresenter(
    process.platform,
    parsePresenterOverride(process.env.ELV_DESKTOP_PRESENTER),
  );
  if (process.platform === 'darwin' && requested === 'canvas') {
    if ((process as NodeJS.Process & { mas?: boolean }).mas) return 'own-window';
    const runtime = mpvRuntimePaths(runtimeEnv());
    if (!runtime?.canvasExecutable || !runtime.ioSurfaceAddon) return 'own-window';
  }
  return requested;
};
const focusOrCreateWindow = (): void => {
  if (!quitTeardown.hasRun()) isQuitting = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    restoreWindowFromTray(mainWindow);
    return;
  }
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) focusWindow(existing);
  else if (appInitialized) createWindow();
};
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!hasLock || gateQuery !== null) return;
  enqueuePlaylistPaths([filePath]);
  if (app.isReady()) focusOrCreateWindow();
});
app.on('open-url', (event, rawUrl) => {
  event.preventDefault();
  if (!hasLock || gateQuery !== null) return;
  if (pendingPairDeepLinks.enqueue(rawUrl) && app.isReady()) focusOrCreateWindow();
});
const devServerOrigin =
  gateQuery !== null
    ? null
    : parseDevServerUrl(process.env.ELV_DEV_SERVER_URL, { isPackaged: app.isPackaged });
if (gateQuery !== null) {
  const gateDir = join(app.getPath('temp'), 'elv-gate');
  try {
    rmSync(gateDir, { recursive: true, force: true });
  } catch {
    // a running gate instance holds its files
  }
  app.setPath('userData', gateDir);
}
const samplers = new WeakMap<MpvEngine, VideoSampler>();
const windowBoundsControllers = new Set<WindowBoundsController>();
const aspectRatioLockControllers = new Map<BrowserWindow, WindowAspectRatioLockController>();
let aspectRatioLockEnabled = false;
const powerBlocker = createPowerBlocker(powerSaveBlocker);
const displayRefreshController = createDesktopDisplayRefreshController();
let cachedTaskbarIcons: TaskbarIcons<NativeImage> | undefined;

function getTaskbarIcons(): TaskbarIcons<NativeImage> {
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
const logger = createDesktopLogger({
  logPath: join(app.getPath('userData'), 'logs', 'elv-desktop.log'),
  mirrorStderr: true,
});
const teardownDeps: QuitTeardownDeps = {
  windowBoundsControllers,
  aspectRatioLockControllers,
  displayRefresh: displayRefreshController,
  powerBlocker,
  log: logger.log,
  clearRefs: () => {
    warmUpPlayerOwner = undefined;
    activeSyncService = undefined;
    trayController = undefined;
    popoutController = undefined;
  },
};
const quitTeardown = createQuitTeardown(teardownDeps);

/** Prints the gate line with main's measurements and quits: a gate run is one line long. */
async function printGateLine(line: string, engine: MpvEngine | undefined): Promise<void> {
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

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: ARTWORK_PROTOCOL_SCHEME, privileges: { standard: true, secure: true } },
]);

function serveRenderer(): void {
  const deps: ServeDeps = {
    isFile: async (path) => (await stat(path)).isFile(),
    fetchFile: (path) => net.fetch(pathToFileURL(path).toString()),
  };
  protocol.handle(APP_SCHEME, (request) => serveAppRequest(rendererDir, request.url, deps));
}

function serveArtwork(cacheDir: string): void {
  protocol.handle(ARTWORK_PROTOCOL_SCHEME, (request) =>
    serveArtworkRequest(cacheDir, request.url, {
      isFile: (path) => lstat(path).then((info) => info.isFile() && !info.isSymbolicLink()),
      readFile,
    }),
  );
}

function createWindow(): void {
  const isGate = gateQuery !== null;
  const appEntryUrl = devServerOrigin !== null ? `${devServerOrigin}/` : `${APP_ORIGIN}/`;
  const targetUrl = isGate ? `${APP_ORIGIN}/?${gateQuery}` : appEntryUrl;
  const statePath = join(app.getPath('userData'), 'window-state.json');
  const saved = isGate ? undefined : loadWindowState(statePath, orderedDisplays(screen));
  const activePresenter = resolveActivePresenterKind();
  const window = new BrowserWindow(
    buildWindowOptions(join(__dirname, '..', 'preload', 'preload.js'), {
      gate: isGate,
      presenter: activePresenter,
      ...(saved === undefined
        ? {}
        : { bounds: { x: saved.x, y: saved.y, width: saved.width, height: saved.height } }),
    }),
  );
  mainWindow = window;
  window.on('close', (event) => {
    if (
      !isQuitting &&
      !isGate &&
      shellPrefs?.getMinimizeToTray() &&
      trayController?.ensureShown() === true
    ) {
      event.preventDefault();
      if (!window.webContents.isDestroyed()) window.webContents.send(WINDOW_CHANNELS.hiddenToTray);
      void activeSyncService?.flushBeforeBackground(2_500);
      window.hide();
    }
  });
  attachWindowSyncLifecycle(window, () => activeSyncService);
  window.on('restore', () => {
    if (!window.webContents.isDestroyed()) window.webContents.send(WINDOW_CHANNELS.windowRestored);
  });
  let boundsController: WindowBoundsController | undefined;
  if (saved) {
    if (saved.isMaximized) window.maximize();
    boundsController = createWindowBoundsController(window, statePath, screen, {
      initialState: saved,
    });
    windowBoundsControllers.add(boundsController);
  }
  const aspectLockController = createWindowAspectRatioLockController(window, screen, {
    gate: isGate,
    initialEnabled: aspectRatioLockEnabled,
  });
  aspectRatioLockControllers.set(window, aspectLockController);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
    if (boundsController) {
      boundsController.dispose();
      windowBoundsControllers.delete(boundsController);
    }
    aspectLockController.dispose();
    aspectRatioLockControllers.delete(window);
  });
  window.setMenuBarVisibility(false);
  lockDownWebContents(
    window.webContents,
    devServerOrigin ? { devOrigin: devServerOrigin } : undefined,
  );
  attachBrowserBackGuard(window);
  attachRendererCrashRecovery(window, { gate: isGate, reloadUrl: appEntryUrl, log: logger.log });
  window.on('page-title-updated', (event) => event.preventDefault());
  window.setTitle(WINDOW_TITLE);
  schedulePostPaintMpvWarmUp(window, {
    gate: isGate,
    presenter: activePresenter,
    onWarmUp: (wc) => warmUpPlayerOwner?.(wc as WebContentsLike),
  });
  void window.loadURL(targetUrl);
}

const cloneFilters = (
  filters: readonly { readonly name: string; readonly extensions: readonly string[] }[],
) => filters.map((f) => ({ name: f.name, extensions: [...f.extensions] }));

function showOpenDialogFor(
  win: BrowserWindow | undefined,
  options: {
    readonly properties: readonly string[];
    readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  },
) {
  const opts = {
    properties: [...options.properties] as Electron.OpenDialogOptions['properties'],
    filters: cloneFilters(options.filters),
  };
  return win && !win.isDestroyed() ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}

/** Kills mpv launchers a crashed run left behind, then serves the player IPC. */
async function startPlayer(): Promise<void> {
  const pidFile = join(app.getPath('userData'), 'mpv-pids.json');
  await sweepLeftovers(pidFile, systemSweepDeps).catch(() => 0);
  const vodCacheRoot = resolveVodCacheRoot(app.getPath('temp'));
  purgeOrphanedVodCacheDirs(vodCacheRoot);
  const macMediaAddon =
    process.platform === 'darwin'
      ? loadMacOsMediaAddon(resolveMacMediaAddonPath(runtimeEnv()))
      : undefined;
  const screensHaveSeparateSpaces = (): boolean =>
    queryMacScreensHaveSeparateSpaces(macMediaAddon, process.platform);
  const mediaBridge =
    gateQuery === null
      ? process.platform === 'linux'
        ? createMprisBridge({
            onRaise: () => focusWindow(BrowserWindow.getAllWindows()[0]),
            onQuit: () => app.quit(),
            log: logger.log,
          })
        : process.platform === 'darwin'
          ? createMacOsMediaBridge({
              addon: macMediaAddon ?? null,
              globalShortcut,
              log: logger.log,
            })
          : undefined
      : undefined;
  teardownDeps.mediaBridge = mediaBridge;
  teardownDeps.playerIpc?.();
  warmUpPlayerOwner = undefined;
  teardownDeps.playerIpc = registerPlayerIpc({
    ipcMain,
    devOrigin: devServerOrigin,
    now: () => performance.now(),
    log: logger.log,
    powerBlocker,
    bindWarmUp: (fn) => {
      warmUpPlayerOwner = fn;
    },
    displayRefreshController,
    ...createPlayerWindowHostHooks({
      getWindow: senderWindow,
      getDisplayId: (win) => String(screen.getDisplayMatching(win.getBounds()).id),
      onAspectRatio: (win, ratio) => aspectRatioLockControllers.get(win)?.setAspectRatio(ratio),
    }),
    ...(mediaBridge ? { mediaBridge } : {}),
    downloadsRoot: getManagedDownloadsDir(app.getPath('userData')),
    pickSubtitleFile: createSubtitleFilePicker<BrowserWindow>({
      getWindowFromSender: senderWindow,
      showOpenDialog: showOpenDialogFor,
    }),
    createTaskbarController: (owner, onAction) => {
      const window = process.platform === 'win32' ? senderWindow(owner) : null;
      return window && !window.isDestroyed()
        ? createTaskbarController({
            window,
            platform: process.platform,
            icons: getTaskbarIcons(),
            onAction,
          })
        : undefined;
    },
    gateReport: app.isPackaged ? undefined : (line, engine) => void printGateLine(line, engine),
    createEngine: async (owner, onUi, engineId, getMultiViewTileCount) => {
      const window = BrowserWindow.fromWebContents(owner as WebContents);
      if (!window) throw new Error('the player needs an app window');
      const runtime = mpvRuntimePaths(runtimeEnv());
      if (!runtime) throw new Error('mpv runtime missing; run pnpm mpv fetch');
      const presenterOverride = parsePresenterOverride(process.env.ELV_DESKTOP_PRESENTER);
      const engine = await createEngineFor(window, {
        runtime,
        platform: process.platform,
        loadMode: 'replace',
        pidFile,
        vodCacheRoot,
        ...(getMultiViewTileCount === undefined ? {} : { getMultiViewTileCount }),
        engineId,
        screensHaveSeparateSpaces,
        ...(presenterOverride === undefined ? {} : { presenterOverride }),
        onUi,
      });
      if (gateQuery !== null) {
        onFirstPlaying(
          (listener) => engine.subscribe(listener),
          () => process.stdout.write(`${GATE_PLAYING_LINE}\n`),
        );
        samplers.set(
          engine,
          createVideoSampler({
            subscribe: (listener) => engine.subscribe(listener),
            sample: () => {
              if (window.isDestroyed() || window.webContents.isDestroyed()) {
                return Promise.resolve({ distinct: 0 });
              }
              const rect = sampleRect(
                window.getContentBounds(),
                engine.lastArea,
                window.webContents.getZoomFactor(),
              );
              return sampleArea(rect);
            },
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            delayMs: 1000,
          }),
        );
      }
      return engine;
    },
  });
}

function createSharedSecretStore(): SecretStore {
  const userData = app.getPath('userData');
  const cipher =
    !app.isPackaged && process.argv.includes('--elv-test-cipher')
      ? createAesGcmTestCipher()
      : createSafeStorageCipher(safeStorage, process.platform);
  return createEncryptedFileSecretStore({
    filePath: join(userData, 'secrets.json'),
    cipher,
    localStatePath: join(userData, 'Local State'),
    log: logger.log,
  });
}

function broadcastCatalogChanged(): void {
  for (const wc of allWebContents()) {
    if (!wc.isDestroyed()) wc.send(CATALOG_CHANNELS.changed);
  }
}

function startCatalog(
  secrets: SecretStore,
  elvServerUrl?: string,
): CatalogCoordinator<MessagePortMain> {
  const coordinator = createCatalogCoordinator<MessagePortMain>({
    dbPath: join(app.getPath('userData'), 'catalog.db'),
    workerPath: join(__dirname, '..', 'utility', 'catalog-worker.js'),
    ...(elvServerUrl !== undefined && elvServerUrl.length > 0 ? { elvServerUrl } : {}),
    secrets,
    fork: (workerPath) => utilityProcess.fork(workerPath, [], { serviceName: 'ELV Catalog' }),
    createChannel: () => new MessageChannelMain(),
    log: logger.log,
    onTelemetry: (event) => activeSyncService?.recordTelemetry(event),
  });
  teardownDeps.catalogIpc = registerCatalogIpc({
    ipcMain,
    coordinator,
    devOrigin: devServerOrigin,
    log: logger.log,
  });
  if (__ELV_DEV_SEED__ && !app.isPackaged && gateQuery === null) {
    const seed = parseDevSeedEnv(process.env, { isPackaged: app.isPackaged });
    if (seed !== undefined) {
      void runDesktopDevSeedOnce({
        seed,
        coordinator,
        secrets,
        onChanged: broadcastCatalogChanged,
      }).catch(() => undefined);
    }
  }
  return coordinator;
}

hasLock = startSingleInstance(app, {
  onSecond: (argv, cwd) => {
    focusOrCreateWindow();
    if (gateQuery === null) {
      enqueuePlaylistPaths(extractPlaylistPathsFromArgv(argv.slice(1), cwd));
      const pairUri = extractPairDeepLinkFromArgv(argv.slice(1));
      if (pairUri !== null) pendingPairDeepLinks.enqueue(pairUri);
    }
  },
});

let catalogCoordinator: CatalogCoordinator<MessagePortMain> | undefined;
let warmUpPlayerOwner: ((owner: WebContentsLike) => void) | undefined;
let activeSyncService: DesktopSyncService | undefined;

registerCatalogQuitHandler({
  app,
  getCoordinator: () => catalogCoordinator,
  beforeShutdown: () =>
    quitTeardown.flushBeforeQuit([() => activeSyncService?.flushBeforeBackground(2_500)], 2_500),
  quit: () => app.quit(),
});

if (hasLock) {
  if (gateQuery === null) {
    enqueuePlaylistPaths(
      extractPlaylistPathsFromArgv(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()),
    );
    const startupPairUri = extractPairDeepLinkFromArgv(process.argv.slice(1));
    if (startupPairUri !== null) pendingPairDeepLinks.enqueue(startupPairUri);
    if (app.isPackaged) app.setAsDefaultProtocolClient('elviptv');
  }
  void app.whenReady().then(async () => {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    lockDownSession(session.defaultSession);
    const artworkCache = createDesktopArtworkCache({
      userDataDir: app.getPath('userData'),
      maxBytes: 512 * 1024 * 1024,
      onClear: () => session.defaultSession.clearCache(),
    });
    teardownDeps.artworkCache = artworkCache;
    serveArtwork(artworkCache.dir);
    teardownDeps.artworkIpc = registerArtworkIpc({
      ipcMain,
      cache: artworkCache,
      devOrigin: devServerOrigin,
      log: logger.log,
    });
    shellPrefs = createShellPrefsController(join(app.getPath('userData'), 'shell-prefs.json'));
    const appBaseUrl = devServerOrigin !== null ? `${devServerOrigin}/` : `${APP_ORIGIN}/`;
    const activePresenter = resolveActivePresenterKind();
    trayController = createTrayController({
      icon: nativeImage.createFromBuffer(createTrayIconPng(32)),
      createTray: (icon) => new Tray(icon),
      buildMenu: (template) => Menu.buildFromTemplate(template),
      onRestore: focusOrCreateWindow,
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
      log: logger.log,
    });
    teardownDeps.tray = trayController;
    popoutController = createPopoutWindowController({
      preloadPath: join(__dirname, '..', 'preload', 'preload.js'),
      appBaseUrl,
      popoutStatePath: join(app.getPath('userData'), POPOUT_STATE_FILENAME),
      screen,
      devOrigin: devServerOrigin,
      presenter: activePresenter,
      getMainWindow: () => mainWindow,
      createWindow: (options) => new BrowserWindow(options),
      log: logger.log,
    });
    teardownDeps.popout = popoutController;
    teardownDeps.windowIpc = registerWindowIpc({
      ipcMain,
      devOrigin: devServerOrigin,
      getWindowFromSender: senderWindow,
      onSetAspectRatioLock: (win, enabled) => {
        aspectRatioLockEnabled = enabled;
        aspectRatioLockControllers.get(win as BrowserWindow)?.setEnabled(enabled);
      },
      getMinimizeToTray: () => shellPrefs?.getMinimizeToTray() ?? true,
      onSetMinimizeToTray: (enabled, labels) => {
        if (labels) trayController?.setLabels(labels);
        return shellPrefs?.setMinimizeToTray(enabled) ?? false;
      },
      onOpenPopout: (payload) =>
        gateQuery === null ? (popoutController?.open(payload) ?? false) : false,
      onClosePopout: () => popoutController?.close(),
      onGetPopoutPayload: (sender) => popoutController?.getPayloadForSender(sender) ?? null,
      onDockPopout: (sender, payload) => popoutController?.dock(sender, payload),
      onOpenExternalUrl: createTrailerWindowController({
        createWindow: (options) => new BrowserWindow(options),
        getParent: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
      }).open,
      log: logger.log,
    });
    teardownDeps.sourcesIpc = registerSourcesIpc<BrowserWindow>({
      ipcMain,
      devOrigin: devServerOrigin,
      getWindowFromSender: senderWindow,
      pendingPlaylists,
      readClipboardText: () => clipboard.readText(),
      showOpenDialog: showOpenDialogFor,
      log: logger.log,
    });
    teardownDeps.lanPairing = registerLanPairingIpc({
      ipcMain,
      devOrigin: devServerOrigin,
      log: logger.log,
    });
    teardownDeps.diagnosticsIpc = registerDiagnosticsIpc<BrowserWindow>({
      ipcMain,
      devOrigin: devServerOrigin,
      getWindowFromSender: senderWindow,
      readLogTail: (maxLines) => logger.readRedactedTail(maxLines),
      showSaveDialog: (win, options) => {
        const opts = {
          defaultPath: options.defaultPath,
          filters: cloneFilters(options.filters),
        };
        return win && !win.isDestroyed()
          ? dialog.showSaveDialog(win, opts)
          : dialog.showSaveDialog(opts);
      },
      writeClipboardText: (text) => clipboard.writeText(text),
      log: logger.log,
    });
    serveRenderer();
    const sharedSecrets = createSharedSecretStore();
    const catalogSnapshotBridge = createDesktopCatalogSnapshotBridge({
      getCoordinator: () => catalogCoordinator,
      secretStore: sharedSecrets,
      onApplied: broadcastCatalogChanged,
    });
    const initialSyncServerUrl =
      typeof __ELV_SYNC_SERVER_URL__ === 'string' && __ELV_SYNC_SERVER_URL__.length > 0
        ? __ELV_SYNC_SERVER_URL__
        : (process.env['ELV_SYNC_SERVER_URL'] ?? '');
    const syncService = createDesktopSyncService({
      secretStore: sharedSecrets,
      initialServerUrl: initialSyncServerUrl,
      platform: `desktop-${process.platform}`,
      appVersion: app.getVersion(),
      mpvVersion: '0.42.0',
      deviceProfile: collectDesktopDeviceProfile({ screen, getLocale: () => app.getLocale() }),
      readLogTail: (maxLines) => logger.readRedactedTail(maxLines),
      getLocalSnapshot: catalogSnapshotBridge.getLocalSnapshot,
      applyMergedSnapshot: catalogSnapshotBridge.applyMergedSnapshot,
    });
    activeSyncService = syncService;
    teardownDeps.errorTelemetry = attachMainErrorTelemetry(() => activeSyncService);
    teardownDeps.syncIpc = registerSyncIpc({
      ipcMain,
      service: syncService,
      pendingPairDeepLinks,
      devOrigin: devServerOrigin,
      getBroadcastTargets: allWebContents,
      log: logger.log,
    });
    catalogCoordinator = startCatalog(sharedSecrets, initialSyncServerUrl);
    bindSyncServerUrlToCatalogCoordinator(
      syncService,
      () => catalogCoordinator,
      gateQuery === null,
    );
    const desktopDownloadManager = createDesktopDownloadManager({
      downloadsDir: getManagedDownloadsDir(app.getPath('userData')),
      log: logger.log,
      ...createDesktopDownloadDeps({ getCoordinator: () => catalogCoordinator, log: logger.log }),
    });
    teardownDeps.downloadManager = desktopDownloadManager;
    teardownDeps.downloadsIpc = registerDownloadsIpc({
      ipcMain,
      manager: desktopDownloadManager,
      devOrigin: devServerOrigin,
      getBroadcastTargets: allWebContents,
      log: logger.log,
    });
    if (gateQuery === null) void desktopDownloadManager.hydrate();
    await startPlayer();
    createWindow();
    appInitialized = true;
    app.on('activate', () => {
      if (!quitTeardown.hasRun()) isQuitting = false;
      if (mainWindow && !mainWindow.isDestroyed()) restoreWindowFromTray(mainWindow);
      else if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// before-quit fires ahead of window.on('close') on Cmd+Q/Alt+F4 so close-to-tray must allow close.
app.on('before-quit', () => {
  isQuitting = true;
});
app.on('will-quit', () => {
  isQuitting = true;
  quitTeardown.run();
});

app.on('window-all-closed', () => {
  displayRefreshController.restoreAll();
  powerBlocker.releaseAll();
  if (process.platform !== 'darwin') app.quit();
});

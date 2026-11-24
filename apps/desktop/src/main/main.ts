import { rmSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  utilityProcess,
  type WebContents,
} from 'electron';
import { ARTWORK_PROTOCOL_SCHEME } from '../shared/artwork-ipc.ts';
import { CATALOG_CHANNELS } from '../shared/catalog-ipc.ts';
import { APP_ORIGIN, APP_SCHEME } from './app-protocol.ts';
import {
  createDesktopArtworkCache,
  type DesktopArtworkCache,
  registerArtworkIpc,
} from './artwork-cache.ts';
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
import {
  createVideoSampler,
  GATE_PLAYING_LINE,
  mergeGateLine,
  onFirstPlaying,
  parseGateFlag,
  sampleRect,
  type VideoSampler,
} from './gate.ts';
import { type LanPairingIpcHandle, registerLanPairingIpc } from './lan-pairing-ipc.ts';
import { createDesktopLogger } from './log.ts';
import {
  createMacOsMediaBridge,
  loadMacOsMediaAddon,
  queryMacScreensHaveSeparateSpaces,
} from './macos-media.ts';
import type { DesktopMediaBridge } from './media-bridge.ts';
import { createMprisBridge } from './mpris/mpris-bridge.ts';
import type { MpvEngine } from './player/engine.ts';
import { createEngineFor } from './player/factory.ts';
import { registerPlayerIpc } from './player/ipc.ts';
import { sweepLeftovers, systemSweepDeps } from './player/mpv/pid-sweep.ts';
import { createPowerBlocker } from './player/power-blocker.ts';
import { parsePresenterOverride } from './player/presenter/choose.ts';
import { sampleArea } from './player/presenter/visible.ts';
import { mpvRuntimePaths, resolveMacMediaAddonPath } from './player/runtime-path.ts';
import { createSubtitleFilePicker } from './player/subtitle-fetch.ts';
import {
  createPendingPlaylistQueue,
  extractPlaylistPathsFromArgv,
  readValidatedPlaylistFile,
} from './playlist-open.ts';
import { lockDownSession, lockDownWebContents } from './security.ts';
import { type ServeDeps, serveAppRequest } from './serve-app.ts';
import { focusWindow, startSingleInstance } from './single-instance.ts';
import { registerSourcesIpc } from './sources-ipc.ts';
import {
  createTaskbarController,
  createTaskbarIconPngs,
  type TaskbarIcons,
} from './taskbar-controls.ts';
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

const rendererDir = join(__dirname, '..', 'renderer');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,HardwareMediaKeyHandling');
}

const gateQuery = parseGateFlag(process.argv, app.isPackaged);
const pendingPlaylists = createPendingPlaylistQueue();
let hasLock = false;
let appInitialized = false;
const enqueuePlaylistPaths = (paths: readonly string[]): void => {
  for (const p of paths) {
    void readValidatedPlaylistFile(p)
      .then((file) => {
        if (file) pendingPlaylists.enqueue(file);
      })
      .catch(() => undefined);
  }
};
const focusOrCreateWindow = (): void => {
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
      isFile: async (path) => {
        const info = await lstat(path);
        return info.isFile() && !info.isSymbolicLink();
      },
      readFile: (path) => readFile(path),
    }),
  );
}

function createWindow(): void {
  const isGate = gateQuery !== null;
  const appEntryUrl = devServerOrigin !== null ? `${devServerOrigin}/` : `${APP_ORIGIN}/`;
  const targetUrl = isGate ? `${APP_ORIGIN}/?${gateQuery}` : appEntryUrl;
  const statePath = join(app.getPath('userData'), 'window-state.json');
  const saved = isGate ? undefined : loadWindowState(statePath, orderedDisplays(screen));
  const window = new BrowserWindow(
    buildWindowOptions(join(__dirname, '..', 'preload', 'preload.js'), {
      gate: isGate,
      ...(saved === undefined
        ? {}
        : {
            bounds: {
              x: saved.x,
              y: saved.y,
              width: saved.width,
              height: saved.height,
            },
          }),
    }),
  );
  if (saved) {
    if (saved.isMaximized) window.maximize();
    const boundsController = createWindowBoundsController(window, statePath, screen, {
      initialState: saved,
    });
    windowBoundsControllers.add(boundsController);
    window.on('closed', () => {
      boundsController.dispose();
      windowBoundsControllers.delete(boundsController);
    });
  }
  const aspectLockController = createWindowAspectRatioLockController(window, screen, {
    gate: isGate,
    initialEnabled: aspectRatioLockEnabled,
  });
  aspectRatioLockControllers.set(window, aspectLockController);
  window.on('closed', () => {
    aspectLockController.dispose();
    aspectRatioLockControllers.delete(window);
  });
  window.setMenuBarVisibility(false);
  lockDownWebContents(
    window.webContents,
    devServerOrigin !== null ? { devOrigin: devServerOrigin } : undefined,
  );
  attachBrowserBackGuard(window);
  attachRendererCrashRecovery(window, {
    gate: isGate,
    reloadUrl: appEntryUrl,
    log: logger.log,
  });
  window.on('page-title-updated', (event) => event.preventDefault());
  window.setTitle(WINDOW_TITLE);
  void window.loadURL(targetUrl);
}

let mediaBridge: DesktopMediaBridge | undefined;

/** Kills mpv launchers a crashed run left behind, then serves the player IPC. */
async function startPlayer(): Promise<void> {
  const pidFile = join(app.getPath('userData'), 'mpv-pids.json');
  await sweepLeftovers(pidFile, systemSweepDeps).catch(() => 0);
  const macMediaAddon =
    process.platform === 'darwin'
      ? loadMacOsMediaAddon(
          resolveMacMediaAddonPath({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: app.getAppPath(),
            platform: process.platform,
            arch: process.arch,
          }),
        )
      : undefined;
  const screensHaveSeparateSpaces = (): boolean =>
    queryMacScreensHaveSeparateSpaces(macMediaAddon, process.platform);
  if (gateQuery === null) {
    mediaBridge =
      process.platform === 'linux'
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
          : undefined;
  }
  registerPlayerIpc({
    ipcMain,
    now: () => performance.now(),
    log: logger.log,
    powerBlocker,
    ...(mediaBridge ? { mediaBridge } : {}),
    pickSubtitleFile: createSubtitleFilePicker<BrowserWindow>({
      getWindowFromSender: (sender) => BrowserWindow.fromWebContents(sender as WebContents),
      showOpenDialog: (win, options) =>
        win && !win.isDestroyed()
          ? dialog.showOpenDialog(win, {
              properties: [...options.properties],
              filters: options.filters.map((f) => ({
                name: f.name,
                extensions: [...f.extensions],
              })),
            })
          : dialog.showOpenDialog({
              properties: [...options.properties],
              filters: options.filters.map((f) => ({
                name: f.name,
                extensions: [...f.extensions],
              })),
            }),
    }),
    createTaskbarController: (owner, onAction) => {
      if (process.platform !== 'win32') return undefined;
      const window = BrowserWindow.fromWebContents(owner as WebContents);
      if (!window || window.isDestroyed()) return undefined;
      return createTaskbarController({
        window,
        platform: process.platform,
        icons: getTaskbarIcons(),
        onAction,
      });
    },
    onVideoAspectRatioChange: (owner, aspectRatio) => {
      const window = BrowserWindow.fromWebContents(owner as WebContents);
      if (window && !window.isDestroyed()) {
        aspectRatioLockControllers.get(window)?.setAspectRatio(aspectRatio);
      }
    },
    gateReport: app.isPackaged ? undefined : (line, engine) => void printGateLine(line, engine),
    createEngine: async (owner, onUi, engineId) => {
      const window = BrowserWindow.fromWebContents(owner as WebContents);
      if (!window) throw new Error('the player needs an app window');
      const runtime = mpvRuntimePaths({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
      });
      if (!runtime) throw new Error('mpv runtime missing; run pnpm mpv fetch');
      const presenterOverride = parsePresenterOverride(process.env.ELV_DESKTOP_PRESENTER);
      const engine = await createEngineFor(window, {
        runtime,
        platform: process.platform,
        loadMode: 'replace',
        pidFile,
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
            sample: () =>
              window.isDestroyed() || window.webContents.isDestroyed()
                ? Promise.resolve({ distinct: 0 })
                : sampleArea(
                    sampleRect(
                      window.getContentBounds(),
                      engine.lastArea,
                      window.webContents.getZoomFactor(),
                    ),
                  ),
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            delayMs: 1000,
          }),
        );
      }
      return engine;
    },
  });
}

function startCatalog(): CatalogCoordinator<MessagePortMain> {
  const userData = app.getPath('userData');
  const useTestCipher = !app.isPackaged && process.argv.includes('--elv-test-cipher');
  const cipher = useTestCipher
    ? createAesGcmTestCipher()
    : createSafeStorageCipher(safeStorage, process.platform);
  const secrets = createEncryptedFileSecretStore({
    filePath: join(userData, 'secrets.json'),
    cipher,
  });
  const coordinator = createCatalogCoordinator<MessagePortMain>({
    dbPath: join(userData, 'catalog.db'),
    workerPath: join(__dirname, '..', 'utility', 'catalog-worker.js'),
    secrets,
    fork: (workerPath) => utilityProcess.fork(workerPath, [], { serviceName: 'ELV Catalog' }),
    createChannel: () => new MessageChannelMain(),
    log: logger.log,
  });
  registerCatalogIpc({
    ipcMain,
    coordinator,
    log: logger.log,
  });
  if (__ELV_DEV_SEED__ && !app.isPackaged && gateQuery === null) {
    const seed = parseDevSeedEnv(process.env, { isPackaged: app.isPackaged });
    if (seed !== undefined) {
      void runDesktopDevSeedOnce({
        seed,
        coordinator,
        secrets,
        onChanged: () => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send(CATALOG_CHANNELS.changed);
            }
          }
        },
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
    }
  },
});

let catalogCoordinator: CatalogCoordinator<MessagePortMain> | undefined;
let artworkCache: DesktopArtworkCache | undefined;
let lanPairingIpc: LanPairingIpcHandle | undefined;

registerCatalogQuitHandler({
  app,
  getCoordinator: () => catalogCoordinator,
  quit: () => app.quit(),
});

if (hasLock) {
  if (gateQuery === null) {
    enqueuePlaylistPaths(
      extractPlaylistPathsFromArgv(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()),
    );
  }
  void app.whenReady().then(async () => {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    lockDownSession(session.defaultSession);
    artworkCache = createDesktopArtworkCache({
      userDataDir: app.getPath('userData'),
      onClear: () => session.defaultSession.clearCache(),
    });
    serveArtwork(artworkCache.dir);
    registerArtworkIpc({
      ipcMain,
      cache: artworkCache,
      log: logger.log,
    });
    registerWindowIpc({
      ipcMain,
      getWindowFromSender: (sender) => BrowserWindow.fromWebContents(sender as WebContents),
      onSetAspectRatioLock: (win, enabled) => {
        aspectRatioLockEnabled = enabled;
        aspectRatioLockControllers.get(win as BrowserWindow)?.setEnabled(enabled);
      },
      log: logger.log,
    });
    registerSourcesIpc<BrowserWindow>({
      ipcMain,
      getWindowFromSender: (sender) => BrowserWindow.fromWebContents(sender as WebContents),
      pendingPlaylists,
      readClipboardText: () => clipboard.readText(),
      showOpenDialog: (win, options) =>
        win && !win.isDestroyed()
          ? dialog.showOpenDialog(win, {
              properties: [...options.properties],
              filters: options.filters.map((f) => ({
                name: f.name,
                extensions: [...f.extensions],
              })),
            })
          : dialog.showOpenDialog({
              properties: [...options.properties],
              filters: options.filters.map((f) => ({
                name: f.name,
                extensions: [...f.extensions],
              })),
            }),
    });
    lanPairingIpc = registerLanPairingIpc({ ipcMain });
    serveRenderer();
    catalogCoordinator = startCatalog();
    await startPlayer();
    createWindow();
    appInitialized = true;
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  void lanPairingIpc?.stop();
});

app.on('will-quit', () => {
  void lanPairingIpc?.dispose();
  lanPairingIpc = undefined;
  mediaBridge?.dispose();
  mediaBridge = undefined;
  for (const ctl of [...windowBoundsControllers]) ctl.dispose();
  windowBoundsControllers.clear();
  for (const ctl of [...aspectRatioLockControllers.values()]) ctl.dispose();
  aspectRatioLockControllers.clear();
  void artworkCache?.dispose();
  powerBlocker.releaseAll();
});

app.on('window-all-closed', () => {
  powerBlocker.releaseAll();
  if (process.platform !== 'darwin') app.quit();
});

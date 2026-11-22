import { rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  MessageChannelMain,
  type MessagePortMain,
  net,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  utilityProcess,
  type WebContents,
} from 'electron';
import { CATALOG_CHANNELS } from '../shared/catalog-ipc.ts';
import { APP_ORIGIN, APP_SCHEME } from './app-protocol.ts';
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
import { createDesktopLogger } from './log.ts';
import type { MpvEngine } from './player/engine.ts';
import { createEngineFor } from './player/factory.ts';
import { registerPlayerIpc } from './player/ipc.ts';
import { sweepLeftovers, systemSweepDeps } from './player/mpv/pid-sweep.ts';
import { createPowerBlocker } from './player/power-blocker.ts';
import { parsePresenterOverride } from './player/presenter/choose.ts';
import { sampleArea } from './player/presenter/visible.ts';
import { mpvRuntimePaths } from './player/runtime-path.ts';
import { lockDownSession, lockDownWebContents } from './security.ts';
import { type ServeDeps, serveAppRequest } from './serve-app.ts';
import { focusWindow, startSingleInstance } from './single-instance.ts';
import { attachRendererCrashRecovery, buildWindowOptions, WINDOW_TITLE } from './window-options.ts';

declare const __ELV_DEV_SEED__: boolean;

const rendererDir = join(__dirname, '..', 'renderer');

const gateQuery = parseGateFlag(process.argv, app.isPackaged);
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
const powerBlocker = createPowerBlocker(powerSaveBlocker);
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
]);

function serveRenderer(): void {
  const deps: ServeDeps = {
    isFile: async (path) => (await stat(path)).isFile(),
    fetchFile: (path) => net.fetch(pathToFileURL(path).toString()),
  };
  protocol.handle(APP_SCHEME, (request) => serveAppRequest(rendererDir, request.url, deps));
}

function createWindow(): void {
  const isGate = gateQuery !== null;
  const appEntryUrl = devServerOrigin !== null ? `${devServerOrigin}/` : `${APP_ORIGIN}/`;
  const targetUrl = isGate ? `${APP_ORIGIN}/?${gateQuery}` : appEntryUrl;
  const window = new BrowserWindow(
    buildWindowOptions(join(__dirname, '..', 'preload', 'preload.js'), {
      gate: isGate,
    }),
  );
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

/** Kills mpv launchers a crashed run left behind, then serves the player IPC. */
async function startPlayer(): Promise<void> {
  const pidFile = join(app.getPath('userData'), 'mpv-pids.json');
  await sweepLeftovers(pidFile, systemSweepDeps).catch(() => 0);
  registerPlayerIpc({
    ipcMain,
    now: () => performance.now(),
    log: logger.log,
    powerBlocker,
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

const hasLock = startSingleInstance(app, {
  onSecond: () => focusWindow(BrowserWindow.getAllWindows()[0]),
});

let catalogCoordinator: CatalogCoordinator<MessagePortMain> | undefined;

registerCatalogQuitHandler({
  app,
  getCoordinator: () => catalogCoordinator,
  quit: () => app.quit(),
});

if (hasLock) {
  void app.whenReady().then(async () => {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    lockDownSession(session.defaultSession);
    serveRenderer();
    catalogCoordinator = startCatalog();
    await startPlayer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', () => {
  powerBlocker.releaseAll();
});

app.on('window-all-closed', () => {
  powerBlocker.releaseAll();
  if (process.platform !== 'darwin') app.quit();
});

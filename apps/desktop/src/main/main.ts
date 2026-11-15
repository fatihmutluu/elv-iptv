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
  protocol,
  safeStorage,
  session,
  utilityProcess,
  type WebContents,
} from 'electron';
import { APP_ORIGIN, APP_SCHEME } from './app-protocol.ts';
import { type CatalogCoordinator, createCatalogCoordinator } from './catalog/coordinator.ts';
import { parseDevSeedEnv, runDesktopDevSeedOnce } from './catalog/dev-seed.ts';
import { registerCatalogIpc, registerCatalogQuitHandler } from './catalog/ipc.ts';
import {
  createAesGcmTestCipher,
  createEncryptedFileSecretStore,
  createSafeStorageCipher,
} from './catalog/secret-store.ts';
import {
  createVideoSampler,
  GATE_PLAYING_LINE,
  mergeGateLine,
  onFirstPlaying,
  parseGateFlag,
  sampleRect,
  type VideoSampler,
} from './gate.ts';
import type { MpvEngine } from './player/engine.ts';
import { createEngineFor } from './player/factory.ts';
import { registerPlayerIpc } from './player/ipc.ts';
import { sweepLeftovers, systemSweepDeps } from './player/mpv/process.ts';
import { sampleArea } from './player/presenter/visible.ts';
import { mpvRuntimePaths } from './player/runtime-path.ts';
import { lockDownSession, lockDownWebContents } from './security.ts';
import { type ServeDeps, serveAppRequest } from './serve-app.ts';
import { focusWindow, startSingleInstance } from './single-instance.ts';
import { buildWindowOptions, WINDOW_TITLE } from './window-options.ts';

declare const __ELV_DEV_SEED__: boolean;

const rendererDir = join(__dirname, '..', 'renderer');

// A gate launch (unpackaged `--elv-gate=<query>`) gets its own user-data folder, wiped at start: the single-instance lock
// lives there, so a dev instance that is open would otherwise make the gate quit at once. A second gate launch at the
// same time still quits (its wipe fails and the lock is taken).
const gateQuery = parseGateFlag(process.argv, app.isPackaged);
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
  const window = new BrowserWindow(
    buildWindowOptions(join(__dirname, '..', 'preload', 'preload.js'), {
      gate: gateQuery !== null,
    }),
  );
  window.setMenuBarVisibility(false);
  lockDownWebContents(window.webContents);
  window.on('page-title-updated', (event) => event.preventDefault());
  window.setTitle(WINDOW_TITLE);
  void window.loadURL(gateQuery === null ? `${APP_ORIGIN}/` : `${APP_ORIGIN}/?${gateQuery}`);
}

/** Kills mpv launchers a crashed run left behind, then serves the player IPC. */
async function startPlayer(): Promise<void> {
  const pidFile = join(app.getPath('userData'), 'mpv-pids.json');
  await sweepLeftovers(pidFile, systemSweepDeps).catch(() => 0);
  registerPlayerIpc({
    ipcMain,
    now: () => Date.now(),
    log: (line) => process.stderr.write(`${line}\n`),
    // The gate driver prints its report through main; a packaged app has no such channel.
    gateReport: app.isPackaged ? undefined : (line, engine) => void printGateLine(line, engine),
    createEngine: async (owner, onUi) => {
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
      const engine = await createEngineFor(window, {
        runtime,
        platform: process.platform,
        loadMode: 'replace',
        pidFile,
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
              sampleArea(
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
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const coordinator = createCatalogCoordinator<MessagePortMain>({
    dbPath: join(userData, 'catalog.db'),
    workerPath: join(__dirname, '..', 'utility', 'catalog-worker.js'),
    secrets,
    fork: (workerPath) => utilityProcess.fork(workerPath, [], { serviceName: 'ELV Catalog' }),
    createChannel: () => new MessageChannelMain(),
    log,
  });
  registerCatalogIpc({
    ipcMain,
    coordinator,
    log,
  });
  if (__ELV_DEV_SEED__ && !app.isPackaged && gateQuery === null) {
    const seed = parseDevSeedEnv(process.env, { isPackaged: app.isPackaged });
    if (seed !== undefined) {
      void runDesktopDevSeedOnce({ seed, coordinator, secrets }).catch(() => undefined);
    }
  }
  return coordinator;
}

// Without the lock this launch quits before any sweep, window or engine: a second instance would kill the first's mpv.
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
    // The default menu reloads the page on Ctrl+R / Cmd+R; development keeps it for the developer tools.
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

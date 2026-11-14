import { rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, net, protocol, type WebContents } from 'electron';
import { APP_ORIGIN, APP_SCHEME } from './app-protocol.ts';
import {
  centerRect,
  createVideoSampler,
  mergeGateLine,
  parseGateFlag,
  type VideoSampler,
} from './gate.ts';
import type { MpvEngine } from './player/engine.ts';
import { createEngineFor } from './player/factory.ts';
import { registerPlayerIpc } from './player/ipc.ts';
import { sweepLeftovers, systemSweepDeps } from './player/mpv/process.ts';
import { sampleArea } from './player/presenter/visible.ts';
import { mpvRuntimePaths } from './player/runtime-path.ts';
import { type ServeDeps, serveAppRequest } from './serve-app.ts';
import { focusWindow, startSingleInstance } from './single-instance.ts';
import { buildWindowOptions, WINDOW_TITLE } from './window-options.ts';

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
  const sample = engine ? await samplers.get(engine)?.result() : undefined;
  const merged =
    engine && sample
      ? mergeGateLine(line, {
          mpvSpawns: engine.spawns,
          loadMode: engine.loadMode,
          presenter: engine.presenterKind,
          videoVisible: sample.videoVisible,
          distinct: sample.distinct,
          coalesceMaxMs: Math.round(engine.maxHoldMs),
        })
      : null;
  if (merged === null) process.stderr.write('gate: the report was refused\n');
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
    buildWindowOptions(join(__dirname, '..', 'preload', 'preload.js')),
  );
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
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
        samplers.set(
          engine,
          createVideoSampler({
            subscribe: (listener) => engine.subscribe(listener),
            sample: () => sampleArea(centerRect(window.getContentBounds())),
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            delayMs: 1000,
          }),
        );
      }
      return engine;
    },
  });
}

// Without the lock this launch quits before any sweep, window or engine: a second instance would kill the first's mpv.
const hasLock = startSingleInstance(app, {
  onSecond: () => focusWindow(BrowserWindow.getAllWindows()[0]),
});

if (hasLock) {
  void app.whenReady().then(async () => {
    // The default menu reloads the page on Ctrl+R / Cmd+R; development keeps it for the developer tools.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    serveRenderer();
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

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, type WebContents } from 'electron';
import { APP_ORIGIN, APP_SCHEME } from './app-protocol.ts';
import { createEngineFor } from './player/factory.ts';
import { registerPlayerIpc } from './player/ipc.ts';
import { sweepLeftovers, systemSweepDeps } from './player/mpv/process.ts';
import { mpvRuntimePaths } from './player/runtime-path.ts';
import { type ServeDeps, serveAppRequest } from './serve-app.ts';
import { buildWindowOptions, WINDOW_TITLE } from './window-options.ts';

const rendererDir = join(__dirname, '..', 'renderer');

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
  void window.loadURL(`${APP_ORIGIN}/`);
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
    gateReport: app.isPackaged ? undefined : (line) => process.stdout.write(`${line}\n`),
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
      return createEngineFor(window, {
        runtime,
        platform: process.platform,
        loadMode: 'replace',
        pidFile,
        onUi,
      });
    },
  });
}

void app.whenReady().then(async () => {
  serveRenderer();
  await startPlayer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

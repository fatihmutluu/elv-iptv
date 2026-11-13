import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol } from 'electron';
import { APP_ORIGIN, APP_SCHEME, CONTENT_SECURITY_POLICY, resolveAppFile } from './app-protocol.ts';
import { buildWindowOptions, WINDOW_TITLE } from './window-options.ts';

const rendererDir = join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveRenderer(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(rendererDir, request.url);
    if (file === null) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return new Response(response.body, { status: response.status, headers });
  });
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

void app.whenReady().then(() => {
  serveRenderer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

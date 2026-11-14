// Test-only Electron main for presenter.spec.ts (bundled by `bundle:e2e`, never packaged). It exposes `elvProbe`
// on the main process global so the spec can drive one presenter with a real mpv and sample the screen.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import type { MpvProcess } from '../src/main/player/mpv/process.ts';
import { spawnMpv } from '../src/main/player/mpv/process.ts';
import type { Rect } from '../src/main/player/presenter/bounds.ts';
import { areaToScreen } from '../src/main/player/presenter/bounds.ts';
import { createPresenter } from '../src/main/player/presenter/create.ts';
import type { PresenterEvent, VideoPresenter } from '../src/main/player/presenter/types.ts';
import { captureArea, sampleArea } from '../src/main/player/presenter/visible.ts';
import { simLiveUrl } from '../src/main/player/testing/sim-streams.ts';
import type { PlayerArea, PresenterKind } from '../src/shared/player-ipc.ts';

const EXECUTABLE = join(__dirname, '..', '..', 'resources', 'mpv', 'win32-x64', 'elv-mpv.exe');
const MPV_ARGS = [
  '--idle=yes',
  '--force-window=immediate',
  '--keep-open=no',
  '--terminal=no',
  '--ao=null',
  '--hwdec=auto-safe',
  '--network-timeout=10',
  '--curl-enabled=no',
  '--title=ELV IPTV probe',
  // The OSC idle logo would count as a busy picture before any video.
  '--script-opts=osc-idlescreen=no',
];
/** The player area in CSS pixels; the page paints it one flat colour, so only video makes it busy. */
let area: PlayerArea = { x: 40, y: 40, width: 800, height: 450, visible: true };
const PAGE = `<!doctype html><html><body style="margin:0;background:#101114;color:#e0e0e0;font:16px sans-serif">
<div style="position:absolute;left:40px;top:40px;width:800px;height:450px;background:#203040"></div>
<div style="position:absolute;left:40px;top:520px">presenter probe <span id="keys">0</span></div>
<script>addEventListener('keydown',()=>{const k=document.getElementById('keys');k.textContent=String(Number(k.textContent)+1)})</script>
</body></html>`;

/** What the spec calls through `electronApp.evaluate`. */
export interface Probe {
  start(kind: PresenterKind): Promise<{ args: readonly string[]; scaleFactor: number; area: Rect }>;
  load(): Promise<void>;
  areaRect(): Rect;
  setArea(next: PlayerArea): Promise<void>;
  sample(rect?: Rect): Promise<number>;
  ping(times: number): Promise<number[]>;
  pressKeys(times: number): Promise<number>;
  moveBy(dx: number, dy: number): Promise<void>;
  /** Drags the top-left corner by (dx, dy): the window shrinks and its content origin moves. */
  resizeFromTopLeft(dx: number, dy: number): Promise<void>;
  videoBounds(): Rect | null;
  mpvGet(names: string[]): Promise<Record<string, unknown>>;
  /** Asks mpv for fullscreen as its OSC button does; returns what owns fullscreen afterwards. */
  fullscreenFromMpv(): Promise<{ app: boolean; mpv: unknown }>;
  leaveFullscreen(): Promise<boolean>;
  events(): PresenterEvent['change'][];
  shot(name: string): Promise<string | null>;
  stop(): Promise<void>;
}

let appWindow: BrowserWindow | undefined;
let presenter: VideoPresenter | undefined;
let mpv: MpvProcess | undefined;
const seen: PresenterEvent['change'][] = [];

const win = (): BrowserWindow => {
  if (!appWindow) throw new Error('probe window not ready');
  return appWindow;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SETTLE_MS = 400;

const probe: Probe = {
  async start(kind) {
    presenter = createPresenter(kind, win(), process.platform);
    presenter.onEvent((e) => seen.push(e.change));
    presenter.setArea(area);
    const args = await presenter.prepare();
    mpv = await spawnMpv({
      executable: EXECUTABLE,
      args: [...MPV_ARGS, ...args],
      platform: process.platform,
      parentPid: process.pid,
    });
    presenter.attach(mpv.client);
    const rect = probe.areaRect();
    return { args, scaleFactor: screen.getDisplayMatching(rect).scaleFactor, area: rect };
  },
  async load() {
    if (!mpv) throw new Error('mpv not started');
    await mpv.client.command(['loadfile', simLiveUrl(), 'replace', -1, {}]);
  },
  areaRect: () => areaToScreen(win().getContentBounds(), area, win().webContents.getZoomFactor()),
  async setArea(next) {
    area = next;
    presenter?.setArea(next);
    await sleep(SETTLE_MS);
  },
  async sample(rect) {
    return (await sampleArea(rect ?? probe.areaRect())).distinct;
  },
  async ping(times) {
    const out: number[] = [];
    for (let i = 0; i < times; i += 1) {
      const t0 = performance.now();
      await win().webContents.executeJavaScript('1+1');
      out.push(Math.round(performance.now() - t0));
      await sleep(50);
    }
    return out;
  },
  async pressKeys(times) {
    for (let i = 0; i < times; i += 1) {
      win().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
      win().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
    }
    await sleep(100);
    return Number(
      await win().webContents.executeJavaScript("document.getElementById('keys').textContent"),
    );
  },
  async moveBy(dx, dy) {
    const [x = 0, y = 0] = win().getPosition();
    win().setPosition(x + dx, y + dy);
    await sleep(SETTLE_MS);
  },
  async resizeFromTopLeft(dx, dy) {
    const b = win().getBounds();
    win().setBounds({ x: b.x + dx, y: b.y + dy, width: b.width - dx, height: b.height - dy });
    await sleep(SETTLE_MS);
  },
  videoBounds() {
    const video = BrowserWindow.getAllWindows().find((w) => w !== appWindow);
    return video ? video.getBounds() : null;
  },
  async mpvGet(names) {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const reply = await mpv?.client.command(['get_property', name]).catch(() => undefined);
      out[name] = reply?.data ?? reply?.error ?? null;
    }
    return out;
  },
  async fullscreenFromMpv() {
    await mpv?.client.command(['set_property', 'fullscreen', true]);
    await sleep(1000);
    const reply = await mpv?.client.command(['get_property', 'fullscreen']);
    return { app: win().isFullScreen(), mpv: reply?.data };
  },
  async leaveFullscreen() {
    presenter?.toggleFullscreen();
    await sleep(1000);
    return win().isFullScreen();
  },
  events: () => [...seen],
  async shot(name) {
    const dir = process.env['ELV_PRESENTER_EVIDENCE_DIR'];
    if (!dir) return null;
    const rect = probe.areaRect();
    const margin = 30;
    const image = await captureArea({
      x: rect.x - margin,
      y: rect.y - margin,
      width: rect.width + 2 * margin,
      height: rect.height + 2 * margin,
    });
    if (!image) return null;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.png`);
    writeFileSync(file, image.toPNG());
    return file;
  },
  async stop() {
    await mpv?.quit(500);
    mpv = undefined;
    presenter?.dispose();
    presenter = undefined;
  },
};

(globalThis as { elvProbe?: Probe }).elvProbe = probe;

void app.whenReady().then(() => {
  appWindow = new BrowserWindow({
    x: 200,
    y: 150,
    useContentSize: true,
    width: 1280,
    height: 720,
    title: 'ELV IPTV presenter probe',
    backgroundColor: '#101114',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  appWindow.setMenuBarVisibility(false);
  void appWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
});

app.on('window-all-closed', () => app.quit());

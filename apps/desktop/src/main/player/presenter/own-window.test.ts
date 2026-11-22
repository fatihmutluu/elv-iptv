import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAppWindow, fakeMpvClient } from '../testing/fake-windows.ts';
import type { Rect } from './bounds.ts';
import { macOwnWindowGeometry } from './bounds.ts';
import { createOwnWindowPresenter } from './own-window.ts';
import type { PresenterEvent } from './types.ts';

const AREA = { x: 40, y: 40, width: 800, height: 450, visible: true };
const scale = (k: number) => (r: Rect) => ({
  x: r.x * k,
  y: r.y * k,
  width: r.width * k,
  height: r.height * k,
});

function setup(content?: Rect) {
  const app = fakeAppWindow(content);
  const presenter = createOwnWindowPresenter({ appWindow: app.window, toScreenPixels: scale(1.5) });
  const events: PresenterEvent[] = [];
  presenter.onEvent((e) => events.push(e));
  return { app, presenter, events };
}

afterEach(() => vi.useRealTimers());

describe('createOwnWindowPresenter', () => {
  it('coversArea is false', () => {
    const { presenter } = setup();
    expect(presenter.kind).toBe('own-window');
    expect(presenter.coversArea).toBe(false);
  });

  it('geometry comes from the first visible area in screen pixels', async () => {
    const { presenter } = setup();
    presenter.setArea({ x: 0, y: 0, width: 10, height: 10, visible: false });
    const args = presenter.prepare();
    presenter.setArea(AREA);
    presenter.setArea({ ...AREA, x: 400 });
    expect(await args).toEqual(['--geometry=1200x675+210+135', '--input-vo-keyboard=yes']);
  });

  it('own-window geometry on darwin maps screen points into work-area backing pixels', async () => {
    const app = fakeAppWindow({ x: 160, y: 360, width: 1280, height: 720 });
    const workArea = { x: 0, y: 30, width: 2056, height: 1299 };
    const presenter = createOwnWindowPresenter({
      appWindow: app.window,
      toScreenPixels: (dip) => macOwnWindowGeometry(dip, workArea, 2),
    });
    presenter.setArea(AREA);
    expect(await presenter.prepare()).toEqual([
      '--geometry=1600x900+400+740',
      '--input-vo-keyboard=yes',
    ]);
  });

  it('uses the latest visible area when one is known', async () => {
    const { app, presenter } = setup();
    app.state.zoom = 2;
    presenter.setArea(AREA);
    expect(await presenter.prepare()).toEqual([
      '--geometry=2400x1350+270+195',
      '--input-vo-keyboard=yes',
    ]);
  });

  it('keeps negative coordinates in the geometry', async () => {
    const { presenter } = setup({ x: -1920, y: -200, width: 1280, height: 720 });
    presenter.setArea({ ...AREA, x: 0, y: 0 });
    expect(await presenter.prepare()).toEqual([
      '--geometry=1200x675+-2880+-300',
      '--input-vo-keyboard=yes',
    ]);
  });

  it('falls back to the content bounds when no visible area arrives in time', async () => {
    vi.useFakeTimers();
    const { presenter } = setup();
    const args = presenter.prepare();
    await vi.advanceTimersByTimeAsync(999);
    presenter.setArea({ ...AREA, visible: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await args).toEqual(['--geometry=1920x1080+150+75', '--input-vo-keyboard=yes']);
  });

  it('follows host move, resize, and visible setArea updates via mpv geometry IPC (#435)', async () => {
    const { app, presenter } = setup();
    presenter.setArea(AREA);
    await presenter.prepare();
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);

    presenter.setArea({ ...AREA, x: 300 });
    expect(mpv.commands).toEqual([['set_property', 'geometry', '1200x675+600+135']]);

    app.state.content = { x: 200, y: 100, width: 1280, height: 720 };
    app.emit('move');
    expect(mpv.commands.at(-1)).toEqual(['set_property', 'geometry', '1200x675+750+210']);

    app.state.content = { x: 200, y: 100, width: 1600, height: 900 };
    app.emit('resize');
    expect(mpv.commands.at(-1)).toEqual(['set_property', 'geometry', '1200x675+750+210']);
    expect(mpv.commands).toHaveLength(3);

    // Minimized, hidden area, fullscreen, and destroyed windows do not push geometry
    app.state.minimized = true;
    app.emit('move');
    expect(mpv.commands).toHaveLength(3);
    app.state.minimized = false;

    app.state.fullscreen = true;
    app.emit('resize');
    expect(mpv.commands).toHaveLength(3);
    app.state.fullscreen = false;

    presenter.setArea({ ...AREA, visible: false });
    app.emit('move');
    expect(mpv.commands).toHaveLength(3);

    presenter.setArea({ ...AREA, visible: true });
    expect(mpv.commands).toHaveLength(4);
    app.state.destroyed = true;
    app.emit('resize');
    expect(mpv.commands).toHaveLength(4);
  });

  it('swallows rejected geometry or fullscreen IPC cleanly', async () => {
    const { app, presenter } = setup();
    presenter.setArea(AREA);
    const mpv = fakeMpvClient();
    mpv.client.command = () => Promise.reject(new Error('pipe closed'));
    presenter.attach(mpv.client);
    expect(() => {
      app.emit('move');
      app.emit('enter-full-screen');
    }).not.toThrow();
    await Promise.resolve();
  });

  it('syncs fullscreen bidirectionally between host window and mpv without feedback loops (#435)', async () => {
    vi.useFakeTimers();
    const { app, presenter } = setup();
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    expect(mpv.observed).toContain('fullscreen');
    const fsId = mpv.observed.indexOf('fullscreen') + 1;

    // Host enters fullscreen -> mpv receives set_property fullscreen true
    app.state.fullscreen = true;
    app.emit('enter-full-screen');
    expect(mpv.commands).toEqual([['set_property', 'fullscreen', true]]);
    // mpv echoing fullscreen: true does not loop back into appWindow.setFullScreen
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: true });
    expect(app.state.fullscreenCalls).toEqual([]);

    // Host leaves fullscreen -> mpv receives set_property fullscreen false
    app.state.fullscreen = false;
    app.emit('leave-full-screen');
    expect(mpv.commands).toEqual([
      ['set_property', 'fullscreen', true],
      ['set_property', 'fullscreen', false],
    ]);
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: false });
    expect(app.state.fullscreenCalls).toEqual([]);

    // mpv independently enters fullscreen -> appWindow.setFullScreen(true), and host event does NOT echo back to mpv
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: true });
    expect(app.state.fullscreenCalls).toEqual([true]);
    app.emit('enter-full-screen');
    expect(mpv.commands).toHaveLength(2);

    // mpv independently leaves fullscreen -> appWindow.setFullScreen(false), and host event does NOT echo back
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: false });
    expect(app.state.fullscreenCalls).toEqual([true, false]);
    app.emit('leave-full-screen');
    expect(mpv.commands).toHaveLength(2);

    // No-op if appWindow is already in the target state or destroyed
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: false });
    expect(app.state.fullscreenCalls).toEqual([true, false]);
    app.state.destroyed = true;
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: true });
    expect(app.state.fullscreenCalls).toEqual([true, false]);

    presenter.dispose();
    expect(mpv.listenerCount()).toBe(0);
    expect(app.listenerCount()).toBe(0);
  });

  it('respects macOS notch safe-area vs desktop fullscreenMode without native modesetting (#269)', async () => {
    const notchedDisplay = {
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 37, width: 1512, height: 945 },
    };
    const app = fakeAppWindow({ x: 0, y: 0, width: 1512, height: 982 });
    app.state.fullscreen = true;
    const fullArea = { x: 0, y: 0, width: 1512, height: 982, visible: true };

    const safePresenter = createOwnWindowPresenter({
      appWindow: app.window,
      toScreenPixels: (dip) => macOwnWindowGeometry(dip, notchedDisplay.workArea, 2),
      displayBoundsOf: () => notchedDisplay,
    });
    safePresenter.setArea(fullArea);
    expect(await safePresenter.prepare()).toEqual([
      '--geometry=3024x1890+0+0',
      '--input-vo-keyboard=yes',
    ]);
    safePresenter.dispose();

    const desktopPresenter = createOwnWindowPresenter({
      appWindow: app.window,
      toScreenPixels: (dip) => macOwnWindowGeometry(dip, notchedDisplay.workArea, 2),
      displayBoundsOf: () => notchedDisplay,
      fullscreenMode: 'desktop',
    });
    desktopPresenter.setArea(fullArea);
    expect(await desktopPresenter.prepare()).toEqual([
      '--geometry=3024x1964+0+-74',
      '--input-vo-keyboard=yes',
    ]);
    desktopPresenter.dispose();
  });

  it('toggleFullscreen cycles mpv fullscreen', async () => {
    const { app, presenter } = setup();
    presenter.toggleFullscreen();
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    presenter.toggleFullscreen();
    expect(mpv.commands).toEqual([['cycle', 'fullscreen']]);
    expect(app.state.fullscreenCalls).toEqual([]);
  });

  it('emits created per mpv window and destroyed when it goes or on dispose', () => {
    const { presenter, events } = setup();
    const first = fakeMpvClient();
    presenter.attach(first.client);
    first.client.close();
    const second = fakeMpvClient();
    presenter.attach(second.client);
    const third = fakeMpvClient();
    presenter.attach(third.client);
    presenter.dispose();
    presenter.dispose();
    expect(events.map((e) => e.change)).toEqual([
      'created',
      'destroyed',
      'created',
      'destroyed',
      'created',
      'destroyed',
    ]);
    expect(second.listenerCount() + third.listenerCount()).toBe(0);
  });

  it('dispose rejects a waiting prepare and ignores later calls', async () => {
    const { presenter, events } = setup();
    const args = presenter.prepare();
    presenter.dispose();
    await expect(args).rejects.toThrow(/disposed/);
    await expect(presenter.prepare()).rejects.toThrow(/disposed/);
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    presenter.toggleFullscreen();
    expect(mpv.commands).toEqual([]);
    expect(events).toEqual([]);
  });

  it('passes --screen=<idx> when screenIndexOf returns a multi-monitor index', async () => {
    const app = fakeAppWindow({ x: -1800, y: 100, width: 1280, height: 720 });
    const presenter = createOwnWindowPresenter({
      appWindow: app.window,
      toScreenPixels: scale(1),
      screenIndexOf: () => 1,
    });
    presenter.setArea(AREA);
    expect(await presenter.prepare()).toEqual([
      '--geometry=800x450+-1760+140',
      '--screen=1',
      '--input-vo-keyboard=yes',
    ]);
  });

  it('guards appWindow.isDestroyed() in prepare, setArea and firstAreaTimeoutMs fallback', async () => {
    vi.useFakeTimers();
    const { app, presenter } = setup();
    const waiting = presenter.prepare();
    const assertion = expect(waiting).rejects.toThrow(/gone|destroyed/);
    app.state.destroyed = true;
    expect(() => presenter.setArea(AREA)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await expect(presenter.prepare()).rejects.toThrow(/gone|destroyed/);
  });

  it('resolves prepare immediately with fresh visibleArea while fullscreen and gates fullscreen IPC only during the bounded transition (#131)', async () => {
    vi.useFakeTimers();
    const app = fakeAppWindow();
    app.state.fullscreen = true;
    const presenter = createOwnWindowPresenter({
      appWindow: app.window,
      toScreenPixels: scale(1.5),
      fullscreenTransitionMs: 400,
    });
    expect(app.listenerCount()).toBe(4);

    // Constructed while already fullscreen: setArea still updates visibleArea and resolves prepare immediately
    const waiting = presenter.prepare();
    presenter.setArea({ ...AREA, x: 200 });
    expect(await waiting).toEqual(['--geometry=1200x675+450+135', '--input-vo-keyboard=yes']);

    // Even right after enter-full-screen, recreating mpv resolves prepare immediately with fresh visibleArea
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    app.emit('enter-full-screen');
    presenter.setArea({ ...AREA, x: 300 });
    expect(await presenter.prepare()).toEqual([
      '--geometry=1200x675+600+135',
      '--input-vo-keyboard=yes',
    ]);

    // enter-full-screen synced fullscreen=true; toggleFullscreen is paused during the bounded transition window
    expect(mpv.commands).toEqual([['set_property', 'fullscreen', true]]);
    presenter.toggleFullscreen();
    expect(mpv.commands).toEqual([['set_property', 'fullscreen', true]]);
    await vi.advanceTimersByTimeAsync(400);
    presenter.toggleFullscreen();
    expect(mpv.commands).toEqual([
      ['set_property', 'fullscreen', true],
      ['cycle', 'fullscreen'],
    ]);

    // leave-full-screen syncs fullscreen=false, arms the bounded transition guard, reconciles geometry after transition, and dispose cleans up
    app.state.fullscreen = false;
    app.emit('leave-full-screen');
    expect(mpv.commands).toEqual([
      ['set_property', 'fullscreen', true],
      ['cycle', 'fullscreen'],
      ['set_property', 'fullscreen', false],
    ]);
    presenter.toggleFullscreen();
    expect(mpv.commands).toHaveLength(3);
    app.state.content = { x: 240, y: 120, width: 1280, height: 720 };
    app.emit('move');
    expect(mpv.commands).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(mpv.commands).toEqual([
      ['set_property', 'fullscreen', true],
      ['cycle', 'fullscreen'],
      ['set_property', 'fullscreen', false],
      ['set_property', 'geometry', '1200x675+810+240'],
    ]);
    presenter.dispose();
    expect(app.listenerCount()).toBe(0);
  });

  it('does not kick an already-fullscreen host out of fullscreen on initial mpv observe(fullscreen=false) snapshot', () => {
    const app = fakeAppWindow();
    app.state.fullscreen = true;
    const presenter = createOwnWindowPresenter({
      appWindow: app.window,
      toScreenPixels: scale(1),
    });
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    const fsId = mpv.observed.indexOf('fullscreen') + 1;
    expect(fsId).toBeGreaterThan(0);

    // mpv sends initial fullscreen=false right after observe_property: keep host fullscreen and sync mpv to true
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: false });
    expect(app.state.fullscreenCalls).toEqual([]);
    expect(mpv.commands).toEqual([['set_property', 'fullscreen', true]]);

    // Echo fullscreen=true settles pending sync, then a subsequent user exit (false) exits host fullscreen
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: true });
    expect(app.state.fullscreenCalls).toEqual([]);
    mpv.push({ event: 'property-change', id: fsId, name: 'fullscreen', data: false });
    expect(app.state.fullscreenCalls).toEqual([false]);
    presenter.dispose();
  });
});

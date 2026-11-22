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

  it('later areas never move mpv window', async () => {
    const { presenter } = setup();
    presenter.setArea(AREA);
    await presenter.prepare();
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    presenter.setArea({ ...AREA, x: 300 });
    presenter.setArea({ ...AREA, visible: false });
    expect(mpv.commands).toEqual([]);
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
    expect(app.listenerCount()).toBe(2);

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

    // Non-essential fullscreen IPC is paused only during the bounded transition window
    presenter.toggleFullscreen();
    expect(mpv.commands).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    presenter.toggleFullscreen();
    expect(mpv.commands).toEqual([['cycle', 'fullscreen']]);

    // leave-full-screen also arms the bounded transition guard and dispose cleans up listeners & timers
    app.emit('leave-full-screen');
    presenter.toggleFullscreen();
    expect(mpv.commands).toHaveLength(1);
    presenter.dispose();
    expect(app.listenerCount()).toBe(0);
  });
});

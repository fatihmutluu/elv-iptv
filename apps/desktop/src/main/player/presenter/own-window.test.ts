import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAppWindow, fakeMpvClient } from '../testing/fake-windows.ts';
import type { Rect } from './bounds.ts';
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
    expect(await args).toEqual(['--geometry=1200x675+210+135']);
  });

  it('uses the latest visible area when one is known', async () => {
    const { app, presenter } = setup();
    app.state.zoom = 2;
    presenter.setArea(AREA);
    expect(await presenter.prepare()).toEqual(['--geometry=2400x1350+270+195']);
  });

  it('keeps negative coordinates in the geometry', async () => {
    const { presenter } = setup({ x: -1920, y: -200, width: 1280, height: 720 });
    presenter.setArea({ ...AREA, x: 0, y: 0 });
    expect(await presenter.prepare()).toEqual(['--geometry=1200x675+-2880+-300']);
  });

  it('falls back to the content bounds when no visible area arrives in time', async () => {
    vi.useFakeTimers();
    const { presenter } = setup();
    const args = presenter.prepare();
    await vi.advanceTimersByTimeAsync(999);
    presenter.setArea({ ...AREA, visible: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(await args).toEqual(['--geometry=1920x1080+150+75']);
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
});

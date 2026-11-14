import { describe, expect, it } from 'vitest';
import { fakeAppWindow, fakeMpvClient, fakeVideoWindow } from '../testing/fake-windows.ts';
import { createChildWindowPresenter } from './child-window.ts';
import type { PresenterEvent } from './types.ts';
import { nativeHwnd } from './video-window-options.ts';

const AREA = { x: 40, y: 40, width: 800, height: 450, visible: true };

function setup() {
  const app = fakeAppWindow();
  const videos: ReturnType<typeof fakeVideoWindow>[] = [];
  const displayListeners = new Set<() => void>();
  const presenter = createChildWindowPresenter({
    appWindow: app.window,
    createWindow: () => {
      const video = fakeVideoWindow();
      videos.push(video);
      return video.window;
    },
    hwndOf: nativeHwnd,
    onDisplayChange: (listener) => {
      displayListeners.add(listener);
      return () => displayListeners.delete(listener);
    },
  });
  const events: PresenterEvent[] = [];
  presenter.onEvent((e) => events.push(e));
  const video = () => {
    const v = videos[0];
    if (!v) throw new Error('no video window yet');
    return v;
  };
  return { app, videos, video, presenter, events, displayListeners };
}

describe('createChildWindowPresenter', () => {
  it('covers the area and passes the HWND as --wid', async () => {
    const { presenter } = setup();
    expect(presenter.kind).toBe('child-window');
    expect(presenter.coversArea).toBe(true);
    expect(await presenter.prepare()).toEqual(['--wid=305441741']);
  });

  it('creates the video window once across many setArea calls', async () => {
    const { presenter, videos } = setup();
    presenter.setArea(AREA);
    const first = await presenter.prepare();
    for (let i = 0; i < 20; i += 1) presenter.setArea({ ...AREA, x: AREA.x + i });
    expect(await presenter.prepare()).toEqual(first);
    expect(videos).toHaveLength(1);
  });

  it('places the video window on the area in screen DIPs', async () => {
    const { app, presenter, video } = setup();
    app.state.zoom = 1.25;
    await presenter.prepare();
    presenter.setArea(AREA);
    expect(video().lastBounds()).toEqual({ x: 150, y: 100, width: 1000, height: 563 });
    expect(video().state.visible).toBe(true);
  });

  it('applies an area that arrived before the window', async () => {
    const { presenter, video } = setup();
    presenter.setArea(AREA);
    await presenter.prepare();
    expect(video().lastBounds()).toEqual({ x: 140, y: 90, width: 800, height: 450 });
    expect(video().state.visible).toBe(true);
  });

  it('stays hidden until an area arrives', async () => {
    const { presenter, video } = setup();
    await presenter.prepare();
    expect(video().state.visible).toBe(false);
    expect(video().state.bounds).toEqual([]);
  });

  it('follows app move, resize, maximize and fullscreen events', async () => {
    const { app, presenter, video } = setup();
    await presenter.prepare();
    presenter.setArea(AREA);
    const events = [
      'move',
      'resize',
      'maximize',
      'unmaximize',
      'enter-full-screen',
      'leave-full-screen',
    ] as const;
    for (const [i, event] of events.entries()) {
      app.state.content = { x: 200 + i * 10, y: -30, width: 1000, height: 600 };
      app.emit(event);
      expect(video().lastBounds()).toEqual({ x: 240 + i * 10, y: 10, width: 800, height: 450 });
    }
  });

  it('follows display changes such as a new scale factor', async () => {
    const { app, presenter, video, displayListeners } = setup();
    await presenter.prepare();
    presenter.setArea(AREA);
    app.state.content = { x: 300, y: 300, width: 1280, height: 720 };
    app.state.zoom = 1.5;
    for (const l of displayListeners) l();
    expect(video().lastBounds()).toEqual({ x: 360, y: 360, width: 1200, height: 675 });
  });

  it('hides when the area is invisible or the app minimizes', async () => {
    const { app, presenter, video } = setup();
    await presenter.prepare();
    presenter.setArea(AREA);
    presenter.setArea({ ...AREA, visible: false });
    expect(video().state.visible).toBe(false);
    presenter.setArea(AREA);
    expect(video().state.visible).toBe(true);

    app.state.minimized = true;
    app.emit('minimize');
    expect(video().state.visible).toBe(false);
    presenter.setArea(AREA);
    expect(video().state.visible).toBe(false);
    app.state.minimized = false;
    app.emit('restore');
    expect(video().state.visible).toBe(true);

    app.state.visible = false;
    app.emit('hide');
    expect(video().state.visible).toBe(false);
    app.state.visible = true;
    app.emit('show');
    expect(video().state.visible).toBe(true);
  });

  it('emits surface created once and destroyed on dispose', async () => {
    const { app, presenter, events, video } = setup();
    await presenter.prepare();
    await presenter.prepare();
    presenter.setArea(AREA);
    expect(events).toEqual([{ type: 'surface', change: 'created' }]);
    presenter.dispose();
    presenter.dispose();
    expect(events).toEqual([
      { type: 'surface', change: 'created' },
      { type: 'surface', change: 'destroyed' },
    ]);
    expect(video().state.destroyed).toBe(true);
    expect(app.listenerCount()).toBe(0);
  });

  it('ignores calls after dispose and rejects a later prepare', async () => {
    const { app, presenter, events, video, displayListeners } = setup();
    await presenter.prepare();
    presenter.dispose();
    presenter.setArea(AREA);
    presenter.toggleFullscreen();
    expect(video().state.bounds).toEqual([]);
    expect(app.state.fullscreenCalls).toEqual([]);
    expect(displayListeners.size).toBe(0);
    await expect(presenter.prepare()).rejects.toThrow(/disposed/);
    expect(events).toHaveLength(2);
  });

  it('reports a video window closed with the app window once and stops placing it', async () => {
    const { app, presenter, events, video, videos } = setup();
    await presenter.prepare();
    video().window.destroy();
    app.emit('move');
    presenter.setArea(AREA);
    presenter.dispose();
    expect(events.map((e) => e.change)).toEqual(['created', 'destroyed']);
    expect(videos).toHaveLength(1);
    await expect(presenter.prepare()).rejects.toThrow();
  });

  it('toggleFullscreen toggles the app window', async () => {
    const { app, presenter } = setup();
    await presenter.prepare();
    presenter.toggleFullscreen();
    presenter.toggleFullscreen();
    expect(app.state.fullscreenCalls).toEqual([true, false]);
  });

  it('redirects mpv fullscreen to the app window', async () => {
    const { app, presenter } = setup();
    await presenter.prepare();
    const mpv = fakeMpvClient();
    presenter.attach(mpv.client);
    expect(mpv.observed).toEqual(['fullscreen']);
    mpv.push({ event: 'property-change', id: 1, name: 'fullscreen', data: false });
    expect(app.state.fullscreenCalls).toEqual([]);
    mpv.push({ event: 'property-change', id: 1, name: 'fullscreen', data: true });
    expect(mpv.commands).toContainEqual(['set_property', 'fullscreen', false]);
    expect(app.state.fullscreenCalls).toEqual([true]);
  });

  it('listens only to the latest attached client', async () => {
    const { app, presenter } = setup();
    await presenter.prepare();
    const old = fakeMpvClient();
    const fresh = fakeMpvClient();
    presenter.attach(old.client);
    presenter.attach(fresh.client);
    expect(old.listenerCount()).toBe(0);
    old.push({ event: 'property-change', id: 1, name: 'fullscreen', data: true });
    expect(app.state.fullscreenCalls).toEqual([]);
    presenter.dispose();
    expect(fresh.listenerCount()).toBe(0);
  });

  it('a failing event listener does not stop the others', async () => {
    const { presenter, events } = setup();
    presenter.onEvent(() => {
      throw new Error('listener bug');
    });
    const seen: PresenterEvent[] = [];
    const off = presenter.onEvent((e) => seen.push(e));
    await presenter.prepare();
    off();
    presenter.dispose();
    expect(seen).toEqual([{ type: 'surface', change: 'created' }]);
    expect(events).toHaveLength(2);
  });
});

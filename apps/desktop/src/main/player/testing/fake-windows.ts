import type { MpvClient } from '../mpv/client.ts';
import type { MpvCommand, MpvEvent, MpvReply } from '../mpv/codec.ts';
import type { Rect } from '../presenter/bounds.ts';
import type { AppWindowEvent, AppWindowLike, VideoWindowLike } from '../presenter/types.ts';

type Listener = () => void;

/** A scriptable app window: tests change its fields, then `emit` the event Electron would send. */
export function fakeAppWindow(content: Rect = { x: 100, y: 50, width: 1280, height: 720 }) {
  const handlers = new Map<AppWindowEvent, Set<Listener>>();
  const state = {
    content,
    zoom: 1,
    minimized: false,
    visible: true,
    fullscreen: false,
    destroyed: false,
    fullscreenCalls: [] as boolean[],
  };
  const window: AppWindowLike = {
    getContentBounds: () => ({ ...state.content }),
    webContents: { getZoomFactor: () => state.zoom },
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isFullScreen: () => state.fullscreen,
    setFullScreen: (flag) => {
      state.fullscreenCalls.push(flag);
      state.fullscreen = flag;
    },
    isDestroyed: () => state.destroyed,
    on: (event, listener) => {
      const set = handlers.get(event) ?? new Set<Listener>();
      set.add(listener);
      handlers.set(event, set);
      return window;
    },
    removeListener: (event, listener) => {
      handlers.get(event)?.delete(listener);
      return window;
    },
  };
  return {
    window,
    state,
    emit(event: AppWindowEvent) {
      for (const l of [...(handlers.get(event) ?? [])]) l();
    },
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** A video window that records bounds and visibility; `destroy` fires `closed` like Electron. */
export function fakeVideoWindow(hwnd = 0x1234abcd) {
  const closed = new Set<Listener>();
  const state = { bounds: [] as Rect[], visible: false, destroyed: false, shows: 0, hides: 0 };
  const handle = Buffer.alloc(8);
  handle.writeUInt32LE(hwnd, 0);
  const window: VideoWindowLike = {
    setBounds: (bounds) => {
      if (state.destroyed) throw new Error('Object has been destroyed');
      state.bounds.push({ ...bounds });
    },
    showInactive: () => {
      state.visible = true;
      state.shows += 1;
    },
    hide: () => {
      state.visible = false;
      state.hides += 1;
    },
    isVisible: () => state.visible,
    isDestroyed: () => state.destroyed,
    destroy: () => {
      if (state.destroyed) return;
      state.destroyed = true;
      state.visible = false;
      for (const l of [...closed]) l();
    },
    getNativeWindowHandle: () => handle,
    on: (_event, listener) => {
      closed.add(listener);
      return window;
    },
  };
  return { window, state, lastBounds: () => state.bounds[state.bounds.length - 1] };
}

/** An mpv client that records commands and lets tests push events and a close. */
export function fakeMpvClient() {
  const commands: MpvCommand[] = [];
  const observed: string[] = [];
  const events = new Set<(e: MpvEvent) => void>();
  const closes = new Set<Listener>();
  const client: MpvClient = {
    command: (cmd) => {
      commands.push(cmd);
      return Promise.resolve<MpvReply>({ request_id: commands.length, error: 'success' });
    },
    observe: (name) => {
      observed.push(name);
      return observed.length;
    },
    onEvent: (l) => {
      events.add(l);
      return () => events.delete(l);
    },
    onClose: (l) => {
      closes.add(l);
      return () => closes.delete(l);
    },
    close: () => {
      for (const l of [...closes]) l();
    },
  };
  return {
    client,
    commands,
    observed,
    push: (e: MpvEvent) => {
      for (const l of [...events]) l(e);
    },
    listenerCount: () => events.size + closes.size,
  };
}

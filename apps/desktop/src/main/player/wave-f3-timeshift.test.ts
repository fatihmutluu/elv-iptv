import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopEngine } from '../../../renderer/src/player/desktop-engine.ts';
import { createPlayerBridge, type IpcRendererLike } from '../../preload/player-bridge.ts';
import { DESKTOP_CAPABILITIES } from '../../shared/player-ipc.ts';
import {
  live,
  playing,
  setupEngineTest,
  URL_A,
  URL_B,
  URL_VOD,
  VOD,
} from './engine-test-helpers.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';
import type { FakeMpvScript } from './mpv/fake-mpv.ts';

const LIVE_WITH_WINDOW: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 2, event: 'file-loaded' },
  { afterMs: 3, property: 'video-params', value: { w: 1920, h: 1080 } },
  {
    afterMs: 4,
    property: 'demuxer-cache-state',
    value: { 'seekable-ranges': [{ start: 10, end: 40 }] },
  },
  { afterMs: 5, property: 'time-pos', value: 35 },
  { afterMs: 6, event: 'playback-restart' },
];

const LIVE_NO_CACHE_EDGE: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 2, event: 'file-loaded' },
  { afterMs: 3, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 5, property: 'time-pos', value: 15 },
  { afterMs: 6, event: 'playback-restart' },
];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('Desktop libmpv bounded live time-shift (#28)', () => {
  it('enables 128MiB back-buffer, emits live time-shift window, clamps live seeks, and jumps to live edge', async () => {
    const s = await setupEngineTest(cleanups, {
      scripts: { [URL_A]: LIVE_WITH_WINDOW },
    });
    expect(s.engine.capabilities.liveSeek).toBe(true);

    s.engine.load(live(1, URL_A));
    await playing(s.events, 1);

    const loadCmd = s.fake.sent.find((c) => c[0] === 'loadfile');
    expect(loadCmd?.[4]).toMatchObject({
      'demuxer-max-bytes': '32MiB',
      'demuxer-max-back-bytes': '128MiB',
    });

    const clockEvent = s.events.find(
      (e): e is Extract<EngineEvent, { type: 'clock' }> =>
        e.type === 'clock' && e.anchor.timeShiftSupported === true,
    );
    expect(clockEvent?.anchor).toMatchObject({
      liveSeekableStartMs: 10_000,
      liveEdgeMs: 40_000,
      timeShiftSupported: true,
    });

    // Seek below liveSeekableStartMs clamps to 10s
    s.engine.seek(1, 2_000);
    await vi.waitFor(() => expect(s.fake.sent).toContainEqual(['seek', 10, 'absolute']), {
      interval: 5,
    });

    // Seek above liveEdgeMs clamps to 40s
    s.engine.seek(1, 90_000);
    await vi.waitFor(() => expect(s.fake.sent).toContainEqual(['seek', 40, 'absolute']), {
      interval: 5,
    });

    // In-window seek passes through accurately
    s.engine.seek(1, 25_000);
    await vi.waitFor(() => expect(s.fake.sent).toContainEqual(['seek', 25, 'absolute']), {
      interval: 5,
    });

    // Stale attempt token is ignored by jumpToLiveEdge
    const seekCountBeforeStale = s.fake.sent.filter((c) => c[0] === 'seek').length;
    s.engine.jumpToLiveEdge?.(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.fake.sent.filter((c) => c[0] === 'seek')).toHaveLength(seekCountBeforeStale);

    // Current attempt jumps directly to liveEdgeMs (40s)
    s.engine.jumpToLiveEdge?.(2);
    await vi.waitFor(
      () =>
        expect(
          s.fake.sent.filter((c) => c[0] === 'seek' && c[1] === 40 && c[2] === 'absolute'),
        ).toHaveLength(2),
      { interval: 5 },
    );
  });

  it('falls back to seek 100 absolute-percent when liveEdgeMs is not cached yet and ignores VOD', async () => {
    const s = await setupEngineTest(cleanups, {
      scripts: { [URL_B]: LIVE_NO_CACHE_EDGE, [URL_VOD]: VOD },
    });

    s.engine.load(live(1, URL_B));
    await playing(s.events, 1);

    s.engine.jumpToLiveEdge?.(1);
    await vi.waitFor(() => expect(s.fake.sent).toContainEqual(['seek', 100, 'absolute-percent']), {
      interval: 5,
    });

    // VOD ignores jumpToLiveEdge
    s.engine.load({ attempt: 2, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(s.events, 2);
    const seeksBefore = s.fake.sent.filter((c) => c[0] === 'seek').length;
    s.engine.jumpToLiveEdge?.(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.fake.sent.filter((c) => c[0] === 'seek')).toHaveLength(seeksBefore);
  });

  it('propagates ClockAnchor time-shift fields and jumpToLiveEdge across preload and player IPC', async () => {
    const handlers = new Map<
      string,
      (ev: { sender: WebContentsLike }, ...args: unknown[]) => unknown
    >();
    const mainListeners = new Map<
      string,
      Set<(ev: { sender: WebContentsLike }, ...args: unknown[]) => unknown>
    >();
    const rendererListeners = new Map<string, Set<(ev: unknown, ...args: unknown[]) => void>>();

    const ipcMain: IpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn),
      on: (ch, fn) => {
        let set = mainListeners.get(ch);
        if (!set) {
          set = new Set();
          mainListeners.set(ch, set);
        }
        set.add(fn);
      },
      removeHandler: (ch) => void handlers.delete(ch),
      removeListener: (ch, fn) => void mainListeners.get(ch)?.delete(fn),
    };

    const webContents: WebContentsLike = {
      id: 1,
      isDestroyed: () => false,
      send: (ch, ...args) => {
        for (const fn of [...(rendererListeners.get(ch) ?? [])]) fn({}, ...args);
      },
      once: () => undefined,
      on: () => undefined,
    };

    const ipcRenderer: IpcRendererLike = {
      invoke: async (ch, ...args) => {
        const fn = handlers.get(ch);
        if (!fn) throw new Error(`missing handler ${ch}`);
        return fn({ sender: webContents }, ...args);
      },
      send: (ch, ...args) => {
        for (const fn of [...(mainListeners.get(ch) ?? [])]) fn({ sender: webContents }, ...args);
      },
      on: (ch, fn) => {
        let set = rendererListeners.get(ch);
        if (!set) {
          set = new Set();
          rendererListeners.set(ch, set);
        }
        set.add(fn);
      },
      removeListener: (ch, fn) => void rendererListeners.get(ch)?.delete(fn),
    };

    const s = await setupEngineTest(cleanups, {
      scripts: { [URL_A]: LIVE_WITH_WINDOW },
    });

    const disposeIpc = registerPlayerIpc({
      ipcMain,
      createEngine: async () => s.engine,
      now: () => 50_000,
      log: () => undefined,
    });
    cleanups.push(async () => disposeIpc());

    const bridge = createPlayerBridge(ipcRenderer);
    const desktopEngine = await createDesktopEngine(bridge, () => 1_000);
    expect(desktopEngine.capabilities).toEqual(DESKTOP_CAPABILITIES);
    expect(desktopEngine.capabilities.liveSeek).toBe(true);

    const rendererEvents: EngineEvent[] = [];
    desktopEngine.subscribe((e) => rendererEvents.push(e));
    desktopEngine.load(live(1, URL_A));

    await vi.waitFor(
      () => {
        const clock = rendererEvents.find(
          (e): e is Extract<EngineEvent, { type: 'clock' }> =>
            e.type === 'clock' && e.anchor.timeShiftSupported === true,
        );
        expect(clock?.anchor).toMatchObject({
          liveSeekableStartMs: 10_000,
          liveEdgeMs: 40_000,
          timeShiftSupported: true,
        });
      },
      { interval: 5 },
    );

    desktopEngine.jumpToLiveEdge?.(1);
    await vi.waitFor(() => expect(s.fake.sent).toContainEqual(['seek', 40, 'absolute']), {
      interval: 5,
    });
  });
});

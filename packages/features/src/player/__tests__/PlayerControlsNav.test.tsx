import { EMPTY_TRACKS, type MediaTracks } from '@elv/playback';
import { act } from '@testing-library/react-native';
import { Platform } from 'react-native';
import {
  createFakeService,
  KEY,
  MULTI_TRACKS,
  mockAndroidTvRuntime,
  pausedAnchor,
  renderControls,
} from './player-controls-harness';

const FAILED = { kind: 'failed', error: { category: 'network', code: 'http' } } as never;

describe('usePlayerControls track picker and TV OSD navigation', () => {
  beforeEach(() => mockAndroidTvRuntime());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('toggles the picker with Menu and keeps the index on Left in audio / Right in subtitles', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(1_000, 60_000));
    const { keys, hook } = await renderControls(svc, { tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.menu));
    expect(hook.result.current.tracksOpen).toBe(true);
    expect(hook.result.current.pickerCursor).toEqual({ column: 'audio', index: 0 });

    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.tap(KEY.left));
    expect(hook.result.current.pickerCursor).toEqual({ column: 'audio', index: 2 });

    await act(async () => keys.tap(KEY.right));
    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.tap(KEY.right));
    expect(hook.result.current.pickerCursor).toEqual({ column: 'subtitles', index: 1 });
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.selectSubtitleTrack).toHaveBeenLastCalledWith('s:1');

    await act(async () => keys.tap(KEY.left));
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.selectAudioTrack).toHaveBeenLastCalledWith('a:1');

    await act(async () => keys.tap(KEY.menu));
    expect(hook.result.current.tracksOpen).toBe(false);
    expect(svc.fake.seek).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('clamps the cursor when the audio column disappears while open', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(1_000, 60_000));
    const { keys, hook } = await renderControls(svc, { tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.menu));
    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.tap(KEY.down));
    const subtitlesOnly: MediaTracks = {
      ...MULTI_TRACKS,
      audio: [],
      selectedAudioId: null,
      selectedSubtitleId: 's:2',
    };
    await hook.rerender({ tracks: subtitlesOnly });
    expect(hook.result.current.pickerCursor).toEqual({ column: 'subtitles', index: 2 });

    await act(async () => keys.tap(KEY.up));
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.selectSubtitleTrack).toHaveBeenLastCalledWith('s:1');
    expect(svc.fake.selectAudioTrack).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('closes the picker when every track disappears', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(1_000, 60_000));
    const { keys, hook } = await renderControls(svc, { tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.menu));
    await hook.rerender({ tracks: EMPTY_TRACKS });
    expect(hook.result.current.tracksOpen).toBe(false);
    await hook.rerender({ tracks: MULTI_TRACKS });
    expect(hook.result.current.tracksOpen).toBe(false);
    await hook.unmount();
  });

  it('closes the picker on Back before exiting, and on retune', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(1_000, 60_000));
    const { keys, refs, hook } = await renderControls(svc, { tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.menu));
    await act(async () => keys.tap(KEY.back));
    expect(hook.result.current.tracksOpen).toBe(false);
    expect(refs.onExitRef.current).not.toHaveBeenCalled();

    await act(async () => keys.tap(KEY.menu));
    await hook.rerender({ tracks: MULTI_TRACKS, itemKey: 'x:src-1:vod:2' });
    expect(hook.result.current.tracksOpen).toBe(false);

    await act(async () => keys.tap(KEY.back));
    expect(refs.onExitRef.current).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('opens the picker with Left on live TV when tracks exist', async () => {
    const svc = createFakeService({ kind: 'playing' });
    const { keys, hook } = await renderControls(svc, { kind: 'live', tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.left));
    expect(hook.result.current.tracksOpen).toBe(true);
    await hook.unmount();
  });

  it('focuses the OSD on Down, moves across mounted buttons and activates them', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(30_000, 60_000));
    const { keys, refs, hook } = await renderControls(svc, { tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.down));
    expect(hook.result.current.tvOsdFocused).toBe(true);
    expect(hook.result.current.tvOsdAction).toBe('tracks');

    await act(async () => keys.tap(KEY.right));
    expect(hook.result.current.tvOsdAction).toBe('tracks');
    await act(async () => keys.tap(KEY.left));
    expect(hook.result.current.tvOsdAction).toBe('seekForward');
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.seek).toHaveBeenLastCalledWith(40_000);
    await act(async () => keys.tap(KEY.left));
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.seek).toHaveBeenLastCalledWith(30_000);
    await act(async () => keys.tap(KEY.left));
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.pause).toHaveBeenCalledTimes(1);

    await act(async () => keys.tap(KEY.right));
    await act(async () => keys.tap(KEY.right));
    await act(async () => keys.tap(KEY.right));
    await act(async () => keys.tap(KEY.select));
    expect(hook.result.current.tracksOpen).toBe(true);
    expect(hook.result.current.tvOsdFocused).toBe(false);
    await act(async () => keys.tap(KEY.back));

    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.tap(KEY.up));
    expect(hook.result.current.tvOsdFocused).toBe(false);
    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.tap(KEY.back));
    expect(hook.result.current.tvOsdFocused).toBe(false);
    expect(refs.onExitRef.current).not.toHaveBeenCalled();

    await act(async () => keys.tap(KEY.down));
    for (let i = 0; i < 4; i += 1) await act(async () => keys.tap(KEY.left));
    expect(hook.result.current.tvOsdAction).toBe('back');
    await act(async () => keys.tap(KEY.select));
    expect(refs.onExitRef.current).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('never activates a vanished Retry button on a healthy VOD', async () => {
    const svc = createFakeService(FAILED, pausedAnchor(30_000, 60_000));
    const { keys, hook } = await renderControls(svc, { status: FAILED, showRetry: true });

    await act(async () => keys.tap(KEY.down));
    expect(hook.result.current.tvOsdAction).toBe('playPause');
    for (let i = 0; i < 3; i += 1) await act(async () => keys.tap(KEY.right));
    expect(hook.result.current.tvOsdAction).toBe('retry');

    svc.setState({ status: { kind: 'playing' } });
    await hook.rerender({ status: { kind: 'playing' }, showRetry: false });
    expect(hook.result.current.tvOsdAction).toBe('seekForward');
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.retry).not.toHaveBeenCalled();
    expect(svc.fake.seek).toHaveBeenLastCalledWith(40_000);
    await hook.unmount();
  });

  it('drops OSD focus when Retry is activated from the OSD or the hook', async () => {
    const svc = createFakeService(FAILED, pausedAnchor(30_000, 60_000));
    const { keys, hook } = await renderControls(svc, { status: FAILED, showRetry: true });

    await act(async () => keys.tap(KEY.down));
    for (let i = 0; i < 3; i += 1) await act(async () => keys.tap(KEY.right));
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.retry).toHaveBeenCalledTimes(1);
    expect(hook.result.current.tvOsdFocused).toBe(false);

    await act(async () => keys.tap(KEY.down));
    await act(async () => hook.result.current.retry());
    expect(svc.fake.retry).toHaveBeenCalledTimes(2);
    expect(hook.result.current.tvOsdFocused).toBe(false);
    await hook.unmount();
  });

  it('retries a failed stream on OK when the OSD is not focused', async () => {
    const svc = createFakeService(FAILED);
    const { keys, hook } = await renderControls(svc, {
      status: FAILED,
      showRetry: true,
      kind: 'live',
    });

    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.retry).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('offers only Back without a service', async () => {
    const { keys, hook } = await renderControls(null, { tracks: MULTI_TRACKS });

    await act(async () => keys.tap(KEY.down));
    expect(hook.result.current.tvOsdAction).toBe('back');
    await act(async () => keys.tap(KEY.right));
    expect(hook.result.current.tvOsdAction).toBe('back');
    await hook.unmount();
  });

  it('ignores web Enter/Space select when a button, radio, or adjustable control has DOM focus', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const listeners = new Map<string, Set<(e?: unknown) => void>>();
    let activeRole: string | null = null;
    const doc = {
      get activeElement() {
        return {
          getAttribute: (name: string) => (name === 'role' ? activeRole : null),
        };
      },
    };
    const win = {
      document: doc,
      addEventListener: (type: string, fn: (e?: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e?: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    const globals = globalThis as unknown as { window?: unknown; document?: unknown };
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    globals.window = win;
    globals.document = doc;

    try {
      const svc = createFakeService({ kind: 'playing' }, pausedAnchor(10_000, 60_000));
      const { hook } = await renderControls(svc, { formFactor: 'desktop' });
      const tapEnter = async () => {
        await act(async () => {
          for (const fn of listeners.get('keydown') ?? []) fn({ key: 'Enter' });
          for (const fn of listeners.get('keyup') ?? []) fn({ key: 'Enter' });
        });
      };

      for (const role of ['button', 'radio', 'adjustable']) {
        activeRole = role;
        await tapEnter();
        expect(svc.fake.pause).not.toHaveBeenCalled();
      }

      activeRole = null;
      await tapEnter();
      expect(svc.fake.pause).toHaveBeenCalledTimes(1);
      await hook.unmount();
    } finally {
      globals.window = prevWindow;
      globals.document = prevDocument;
    }
  });
});

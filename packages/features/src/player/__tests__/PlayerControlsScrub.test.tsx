import { act } from '@testing-library/react-native';
import { SCRUB_SETTLE_MS } from '../scrub-controller';
import {
  createFakeService,
  KEY,
  mockAndroidTvRuntime,
  pausedAnchor,
  renderControls,
} from './player-controls-harness';

describe('usePlayerControls VOD scrub and transport keys', () => {
  beforeEach(() => mockAndroidTvRuntime());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('commits a tapped step with one seek on key release', async () => {
    const svc = createFakeService({ kind: 'paused' }, pausedAnchor(40_000, 600_000));
    const { keys, hook } = await renderControls(svc, { status: { kind: 'paused' } });

    await act(async () => keys.down(KEY.right));
    expect(hook.result.current.previewPositionMs).toBe(50_000);
    expect(svc.fake.seek).not.toHaveBeenCalled();

    await act(async () => keys.up(KEY.right));
    expect(svc.fake.seek).toHaveBeenCalledTimes(1);
    expect(svc.fake.seek).toHaveBeenCalledWith(50_000);
    expect(hook.result.current.previewPositionMs).toBeUndefined();
    await hook.unmount();
  });

  it('previews accelerating held repeats without intermediate seeks', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(0, 3_600_000));
    const { keys, hook } = await renderControls(svc);

    await act(async () => keys.down(KEY.right));
    await act(async () => {
      jest.advanceTimersByTime(650);
    });
    expect(hook.result.current.previewPositionMs).toBe(40_000);
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(svc.fake.seek).not.toHaveBeenCalled();
    const preview = hook.result.current.previewPositionMs ?? 0;
    expect(preview).toBeGreaterThan(40_000 + 8 * 30_000);

    await act(async () => keys.up(KEY.right));
    expect(svc.fake.seek).toHaveBeenCalledTimes(1);
    expect(svc.fake.seek).toHaveBeenCalledWith(preview);
    await hook.unmount();
  });

  it('commits on the settle timer when the runtime reports no release', async () => {
    const svc = createFakeService({ kind: 'paused' }, pausedAnchor(40_000, 600_000));
    const { hook } = await renderControls(svc, {
      status: { kind: 'paused' },
      formFactor: 'desktop',
    });
    const onKeyDown = hook.result.current.desktopFallbackKeyProps.onKeyDown as (e: {
      key: string;
      repeat?: boolean;
    }) => void;

    await act(async () => onKeyDown({ key: 'ArrowLeft' }));
    await act(async () => onKeyDown({ key: 'ArrowLeft', repeat: true }));
    expect(hook.result.current.previewPositionMs).toBe(0);
    await act(async () => onKeyDown({ key: 'ArrowRight' }));
    expect(hook.result.current.previewPositionMs).toBe(10_000);
    await act(async () => {
      jest.advanceTimersByTime(SCRUB_SETTLE_MS - 1);
    });
    expect(svc.fake.seek).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(svc.fake.seek).toHaveBeenCalledTimes(1);
    expect(svc.fake.seek).toHaveBeenCalledWith(10_000);
    await hook.unmount();
  });

  it('does not seek before the playback position is known', async () => {
    const svc = createFakeService({ kind: 'tuning' });
    const { keys, hook } = await renderControls(svc, { status: { kind: 'tuning' } });

    await act(async () => keys.tap(KEY.right));
    await act(async () => keys.tap(KEY.left));
    expect(svc.fake.seek).not.toHaveBeenCalled();
    expect(hook.result.current.previewPositionMs).toBeUndefined();
    await act(async () => hook.result.current.seekStepForward());
    expect(svc.fake.seek).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('cancels a pending scrub on retune and on unmount', async () => {
    const svc = createFakeService({ kind: 'paused' }, pausedAnchor(40_000, 600_000));
    const { keys, hook } = await renderControls(svc, { status: { kind: 'paused' } });

    await act(async () => keys.down(KEY.right));
    await hook.rerender({ status: { kind: 'tuning' }, itemKey: 'x:src-1:vod:2' });
    expect(hook.result.current.previewPositionMs).toBeUndefined();
    await act(async () => keys.up(KEY.right));
    expect(svc.fake.seek).not.toHaveBeenCalled();

    await act(async () => keys.down(KEY.right));
    await hook.unmount();
    jest.advanceTimersByTime(1_000);
    expect(svc.fake.seek).not.toHaveBeenCalled();
  });

  it('cancels a pending scrub when pause is pressed and when playback fails', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(40_000, 600_000));
    const { keys, hook } = await renderControls(svc);

    await act(async () => keys.down(KEY.right));
    await act(async () => keys.tap(KEY.pause));
    expect(svc.fake.pause).toHaveBeenCalledTimes(1);
    expect(hook.result.current.previewPositionMs).toBeUndefined();
    await act(async () => keys.up(KEY.right));

    await act(async () => keys.down(KEY.left));
    expect(hook.result.current.previewPositionMs).toBe(30_000);
    await hook.rerender({ status: { kind: 'idle' } });
    expect(hook.result.current.previewPositionMs).toBeUndefined();
    await act(async () => keys.up(KEY.left));
    expect(svc.fake.seek).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('confirms a pending scrub with OK instead of toggling play/pause', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(40_000, 600_000));
    const { keys, hook } = await renderControls(svc);

    await act(async () => keys.tap(KEY.right));
    await act(async () => keys.down(KEY.right));
    await act(async () => keys.tap(KEY.select));
    expect(svc.fake.seek).toHaveBeenLastCalledWith(60_000);
    expect(svc.fake.pause).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('replays an ended VOD on Play and ignores Pause there', async () => {
    const svc = createFakeService({ kind: 'ended' }, pausedAnchor(600_000, 600_000));
    const { keys, hook } = await renderControls(svc, { status: { kind: 'ended' } });

    await act(async () => keys.tap(KEY.pause));
    expect(svc.fake.pause).not.toHaveBeenCalled();
    await act(async () => keys.tap(KEY.play));
    expect(svc.fake.play).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isPausedOrEnded).toBe(true);
    await hook.unmount();
  });

  it('routes Play/Pause keys by status', async () => {
    const svc = createFakeService({ kind: 'paused' }, pausedAnchor(1_000, 600_000));
    const { keys, hook } = await renderControls(svc, { status: { kind: 'paused' } });

    await act(async () => keys.tap(KEY.pause));
    await act(async () => keys.tap(KEY.play));
    expect(svc.fake.pause).not.toHaveBeenCalled();
    expect(svc.fake.play).toHaveBeenCalledTimes(1);

    svc.setState({ status: { kind: 'playing' } });
    await act(async () => keys.tap(KEY.play));
    await act(async () => keys.tap(KEY.playPause));
    expect(svc.fake.play).toHaveBeenCalledTimes(1);
    expect(svc.fake.pause).toHaveBeenCalledTimes(1);

    svc.setState({
      status: { kind: 'failed', error: { category: 'network', code: 'http' } as never },
    });
    await act(async () => keys.tap(KEY.play));
    expect(svc.fake.retry).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('seeks immediately from the on-screen step buttons and the progress ratio', async () => {
    const svc = createFakeService({ kind: 'playing' }, pausedAnchor(40_000, 100_000));
    const { hook } = await renderControls(svc, { formFactor: 'desktop' });

    await act(async () => hook.result.current.seekStepForward());
    expect(svc.fake.seek).toHaveBeenLastCalledWith(50_000);
    await act(async () => hook.result.current.seekStepBack());
    expect(svc.fake.seek).toHaveBeenLastCalledWith(40_000);
    await act(async () => hook.result.current.seekToRatio(0.25));
    expect(svc.fake.seek).toHaveBeenLastCalledWith(25_000);
    await act(async () => hook.result.current.seekToRatio(Number.NaN));
    expect(svc.fake.seek).toHaveBeenCalledTimes(3);
    await hook.unmount();
  });

  it('zaps live channels with up/down and passes repeat flag on held keys', async () => {
    const svc = createFakeService({ kind: 'playing' });
    const { keys, refs, hook } = await renderControls(svc, { kind: 'live' });

    await act(async () => keys.tap(KEY.up));
    await act(async () => keys.tap(KEY.down));
    await act(async () => keys.down(KEY.up));
    await act(async () => {
      jest.advanceTimersByTime(650);
    });
    await act(async () => keys.up(KEY.up));
    expect(refs.zapByRef.current.mock.calls).toEqual([
      [1, false],
      [-1, false],
      [1, false],
      [1, true],
    ]);
    await act(async () => keys.tap(KEY.right));
    expect(svc.fake.seek).not.toHaveBeenCalled();
    await hook.unmount();
  });
});

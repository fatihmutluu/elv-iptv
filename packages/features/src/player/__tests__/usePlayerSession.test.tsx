import type { PlaybackService } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { HostKey, VideoHost } from '../../ports/video-host';
import { usePlayerSession } from '../usePlayerSession';
import { createManualClock } from './player-test-harness';

const TARGET: PlayTarget = {
  itemKey: 'vod:1',
  sourceId: 'src-1',
  title: 'Cinema Demo',
  kind: 'vod',
};

describe('usePlayerSession videoInfo and fullscreen tracking (#58, #394)', () => {
  it('exposes videoInfo from PlaybackState and tracks host isFullscreen transitions', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    let fullscreen = true;
    let fsListener: ((next: boolean) => void) | undefined;
    const unsubscribeFs = jest.fn(() => {
      fsListener = undefined;
    });

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: () => <View />,
        isFullscreen: () => fullscreen,
        onFullscreenChange: (listener) => {
          fsListener = listener;
          return unsubscribeFs;
        },
      }),
    };

    const serviceRef = { current: null as PlaybackService | null };
    const clockRef = { current: { now: manual.now } };
    const timersRef = {
      current: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    };
    const hostKeyRef = { current: (_key: HostKey) => undefined };
    const onExitRef = { current: jest.fn() };
    const onServiceReady = jest.fn();

    const hook = await renderHook(() =>
      usePlayerSession({
        videoHost,
        activeTarget: TARGET,
        serviceRef,
        clockRef,
        timersRef,
        hostKeyRef,
        onExitRef,
        onServiceReady,
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.sessionState.kind).toBe('ready');
    });

    // Initial fullscreen read from openedEngine.isFullscreen()
    expect(hook.result.current.isFullscreen).toBe(true);
    expect(hook.result.current.videoInfo).toBeUndefined();

    // Fullscreen change subscription updates state
    await act(async () => {
      fullscreen = false;
      fsListener?.(false);
    });
    expect(hook.result.current.isFullscreen).toBe(false);

    // Emit decoded videoInfo through the active playback service
    const svc = hook.result.current.activeService;
    expect(svc).not.toBeNull();
    const attempt = svc?.tune({
      item: TARGET.itemKey,
      accountKey: TARGET.sourceId,
      kind: 'vod',
      resolve: async () => ({
        ok: true as const,
        value: { url: 'http://sim.example.test/vod.mkv', headers: {} },
      }),
    });
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const info = { width: 3840, height: 2160, fps: 60, codec: 'hevc', hdr: 'hdr10' as const };
    await act(async () => {
      engine.emit({ attempt: attempt ?? 1, type: 'mediaInfo', info });
    });
    expect(hook.result.current.videoInfo).toEqual(info);

    await hook.unmount();
    expect(unsubscribeFs).toHaveBeenCalledTimes(1);
  });

  it('stops PlaybackService and invokes onExit when host emits stop (#412)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    let hostKeyListener: ((key: HostKey) => void) | undefined;
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: () => <View />,
        onHostKey: (listener) => {
          hostKeyListener = listener;
          return () => {
            hostKeyListener = undefined;
          };
        },
      }),
    };
    const serviceRef = { current: null as PlaybackService | null };
    const clockRef = { current: { now: manual.now } };
    const timersRef = {
      current: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    };
    const hostKeyRef = { current: jest.fn<void, [HostKey]>() };
    const onExitRef = { current: jest.fn() };

    const hook = await renderHook(() =>
      usePlayerSession({
        videoHost,
        activeTarget: TARGET,
        serviceRef,
        clockRef,
        timersRef,
        hostKeyRef,
        onExitRef,
        onServiceReady: () => undefined,
      }),
    );

    await waitFor(() => {
      expect(hook.result.current.sessionState.kind).toBe('ready');
    });

    const svc = hook.result.current.activeService;
    expect(svc).not.toBeNull();
    svc?.tune({
      item: TARGET.itemKey,
      accountKey: TARGET.sourceId,
      kind: 'vod',
      resolve: async () => ({
        ok: true as const,
        value: { url: 'http://sim.example.test/vod.mkv', headers: {} },
      }),
    });
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });

    await act(async () => {
      hostKeyListener?.('stop');
    });
    expect(engine.commands.some((c) => c.name === 'stop')).toBe(true);
    expect(onExitRef.current).toHaveBeenCalledTimes(1);
    expect(hostKeyRef.current).not.toHaveBeenCalled();

    await hook.unmount();
  });
});

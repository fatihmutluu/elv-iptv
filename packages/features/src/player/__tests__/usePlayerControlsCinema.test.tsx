import type { MediaTracks, PlaybackService, PlaybackTimers } from '@elv/playback';
import { RemoteKeysProvider } from '@elv/ui-kit';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { SKIP_BACK_SUBTITLES_WINDOW_MS } from '../skip-back-subtitles';
import { usePlayerControls } from '../usePlayerControls';
import { createFakeService, pausedAnchor } from './player-controls-harness';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const SUB_TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng' }],
  subtitles: [
    { id: 's:1', language: 'eng' },
    { id: 's:2', language: 'tur' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

function createRichFakeService(
  status: Parameters<typeof createFakeService>[0],
  anchor = pausedAnchor(60_000, 300_000),
) {
  const base = createFakeService(status, anchor);
  const setSpeed = jest.fn();
  const svc = Object.assign(base.fake, { setSpeed });
  return {
    ...base,
    fake: svc,
    service: svc as unknown as PlaybackService,
  };
}

async function setupControls(opts: {
  kind?: 'vod' | 'live';
  formFactor?: 'desktop' | 'tv' | 'phone';
  tracks?: MediaTracks;
  initialOsdHidden?: boolean;
  initialVolume?: number;
  autoSubtitlesOnSkipBack?: boolean;
  hasInfo?: boolean;
  hasChannelList?: boolean;
  onSetVolume?: jest.Mock;
  onPersistVolume?: jest.Mock;
  onToggleMute?: jest.Mock;
  onToggleAutoSubtitlesOnSkipBack?: jest.Mock;
}) {
  const manual = createManualClock();
  const keys = createFakeAndroidKeys();
  const svc = createRichFakeService({ kind: 'playing' });
  const timers: PlaybackTimers = {
    setTimeout: manual.schedule,
    clearTimeout: manual.cancel,
  };
  const onExitRef = { current: jest.fn() };
  const zapByRef = { current: jest.fn() };
  const serviceRef = { current: svc.service };
  const clockRef = { current: { now: manual.now } };
  const timersRef = { current: timers };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <RemoteKeysProvider android={keys.source}>{children}</RemoteKeysProvider>
  );

  const hook = await renderHook(
    (p: {
      itemKey?: string;
      tracks?: MediaTracks;
      autoSubtitlesOnSkipBack?: boolean;
      initialVolume?: number;
    }) => {
      const tracks = p.tracks ?? opts.tracks ?? SUB_TRACKS;
      const target: PlayTarget = {
        itemKey: p.itemKey ?? 'vod:1',
        sourceId: 'src-1',
        title: 'Cinema Feature',
        kind: opts.kind ?? 'vod',
      };
      return usePlayerControls({
        formFactor: opts.formFactor ?? 'desktop',
        activeTarget: target,
        status: { kind: 'playing' },
        tracks,
        hasTracks: tracks.audio.length > 0 || tracks.subtitles.length > 0,
        showRetry: false,
        hasService: true,
        hasSettings: true,
        hasInfo: opts.hasInfo ?? true,
        hasChannelList: opts.hasChannelList ?? opts.kind === 'live',
        initialOsdHidden: opts.initialOsdHidden,
        autoHideOsdMs: 3_500,
        initialVolume: p.initialVolume ?? opts.initialVolume,
        onSetVolume: opts.onSetVolume,
        onPersistVolume: opts.onPersistVolume,
        onToggleMute: opts.onToggleMute,
        autoSubtitlesOnSkipBack: p.autoSubtitlesOnSkipBack ?? opts.autoSubtitlesOnSkipBack,
        onToggleAutoSubtitlesOnSkipBack: opts.onToggleAutoSubtitlesOnSkipBack,
        serviceRef,
        clockRef,
        timersRef,
        onExitRef,
        zapByRef,
      });
    },
    { initialProps: {}, wrapper },
  );

  return { manual, keys, svc, onExitRef, hook };
}

describe('usePlayerControls cinema ergonomics (#391, #58, #394, #114, #57)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clamps, persists, unmutes, and wheel-steps volume while bypassing wheel when any sheet is open (#394)', async () => {
    const onSetVolume = jest.fn();
    const onPersistVolume = jest.fn();
    const onToggleMute = jest.fn();
    const d = await setupControls({
      formFactor: 'desktop',
      initialOsdHidden: true,
      initialVolume: 60,
      onSetVolume,
      onPersistVolume,
      onToggleMute,
    });

    expect(d.hook.result.current.volume).toBe(60);
    expect(d.hook.result.current.osdTier).toBe('hidden');

    // Wheel up steps +5 and peeks 'progress' tier
    let handled = false;
    await act(async () => {
      handled = d.hook.result.current.handleWheelVolume(-120);
    });
    expect(handled).toBe(true);
    expect(d.hook.result.current.volume).toBe(65);
    expect(d.hook.result.current.osdTier).toBe('progress');
    expect(onSetVolume).toHaveBeenLastCalledWith(65);
    expect(onPersistVolume).toHaveBeenLastCalledWith(65);

    // Wheel down steps -5
    await act(async () => {
      handled = d.hook.result.current.handleWheelVolume(120);
    });
    expect(handled).toBe(true);
    expect(d.hook.result.current.volume).toBe(60);

    // Mute, then setVolume(> 0) unmutes cleanly
    await act(async () => {
      d.hook.result.current.toggleMute();
    });
    expect(d.hook.result.current.muted).toBe(true);
    await act(async () => {
      d.hook.result.current.setVolume(80);
    });
    expect(d.hook.result.current.muted).toBe(false);
    expect(d.hook.result.current.volume).toBe(80);

    // Open Info sheet -> handleWheelVolume returns false without changing volume
    await act(async () => {
      d.hook.result.current.openInfo();
    });
    await act(async () => {
      handled = d.hook.result.current.handleWheelVolume(-120);
    });
    expect(handled).toBe(false);
    expect(d.hook.result.current.volume).toBe(80);

    await d.hook.unmount();
  });

  it('wires skip-back subtitles on backward VOD seek, peeks progress OSD, and cancels on manual subtitle pick (#114, #391)', async () => {
    const d = await setupControls({
      kind: 'vod',
      initialOsdHidden: true,
      autoSubtitlesOnSkipBack: true,
    });

    await act(async () => {
      d.hook.result.current.seekStepBack();
    });
    expect(d.hook.result.current.osdTier).toBe('progress');
    expect(d.svc.fake.selectSubtitleTrack).toHaveBeenCalledTimes(1);
    expect(d.svc.fake.selectSubtitleTrack).toHaveBeenLastCalledWith('s:1');

    // Auto-restores off after 15s
    await act(async () => {
      d.manual.advance(SKIP_BACK_SUBTITLES_WINDOW_MS);
    });
    expect(d.svc.fake.selectSubtitleTrack).toHaveBeenCalledTimes(2);
    expect(d.svc.fake.selectSubtitleTrack).toHaveBeenLastCalledWith(null);

    // Rewind again, then manually select s:2 -> cancels auto-restore!
    await act(async () => {
      d.hook.result.current.seekStepBack();
    });
    expect(d.svc.fake.selectSubtitleTrack).toHaveBeenLastCalledWith('s:1');
    await act(async () => {
      d.hook.result.current.selectSubtitle('s:2');
    });
    await act(async () => {
      d.manual.advance(SKIP_BACK_SUBTITLES_WINDOW_MS);
    });
    expect(d.svc.fake.selectSubtitleTrack).toHaveBeenLastCalledWith('s:2');

    await d.hook.unmount();
  });

  it('holds 2.0x speed on VOD and restores prior speed on release or unmount, ignoring Live (#114)', async () => {
    const vod = await setupControls({ kind: 'vod' });
    await act(async () => {
      vod.hook.result.current.selectSpeed(1.25);
    });
    expect(vod.hook.result.current.playbackSpeed).toBe(1.25);
    expect(vod.hook.result.current.holdSpeedActive).toBe(false);

    await act(async () => {
      vod.hook.result.current.startHoldSpeed();
    });
    expect(vod.hook.result.current.holdSpeedActive).toBe(true);
    expect(vod.hook.result.current.playbackSpeed).toBe(2);
    expect(vod.svc.fake.setSpeed).toHaveBeenLastCalledWith(2);

    await act(async () => {
      vod.hook.result.current.endHoldSpeed();
    });
    expect(vod.hook.result.current.holdSpeedActive).toBe(false);
    expect(vod.hook.result.current.playbackSpeed).toBe(1.25);
    expect(vod.svc.fake.setSpeed).toHaveBeenLastCalledWith(1.25);

    // Unmount while holding restores prior speed on the service
    await act(async () => {
      vod.hook.result.current.startHoldSpeed();
    });
    await vod.hook.unmount();
    expect(vod.svc.fake.setSpeed).toHaveBeenLastCalledWith(1.25);

    // Live ignores hold speed
    const live = await setupControls({ kind: 'live' });
    await act(async () => {
      live.hook.result.current.startHoldSpeed();
    });
    expect(live.hook.result.current.holdSpeedActive).toBe(false);
    expect(live.svc.fake.setSpeed).not.toHaveBeenCalled();
    await live.hook.unmount();
  });

  it('routes desktop shortcuts (i, Shift+I, g), host keys (info, channel-list), and Back step-down cleanly (#58, #57)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android' as typeof Platform.OS);
    const live = await setupControls({
      kind: 'live',
      formFactor: 'desktop',
      hasInfo: true,
      hasChannelList: true,
      initialOsdHidden: true,
    });

    const onKeyDown = live.hook.result.current.desktopFallbackKeyProps.onKeyDown as (
      e: Record<string, unknown>,
    ) => void;

    // Plain 'i' toggles Info sheet
    await act(async () => {
      onKeyDown({ key: 'i', preventDefault: jest.fn() });
    });
    expect(live.hook.result.current.infoOpen).toBe(true);
    expect(live.hook.result.current.statsVisible).toBe(false);

    // Back closes Info without exiting
    await act(async () => {
      live.hook.result.current.handleBack();
    });
    expect(live.hook.result.current.infoOpen).toBe(false);
    expect(live.onExitRef.current).not.toHaveBeenCalled();

    // Shift+I toggles Stats HUD without opening Info
    await act(async () => {
      onKeyDown({ key: 'I', shiftKey: true, preventDefault: jest.fn() });
    });
    expect(live.hook.result.current.statsVisible).toBe(true);
    expect(live.hook.result.current.infoOpen).toBe(false);

    // Plain 'g' opens Channel List on Live
    await act(async () => {
      onKeyDown({ key: 'g', preventDefault: jest.fn() });
    });
    expect(live.hook.result.current.channelListOpen).toBe(true);

    // Back closes Channel List without exiting
    await act(async () => {
      live.hook.result.current.handleBack();
    });
    expect(live.hook.result.current.channelListOpen).toBe(false);
    expect(live.onExitRef.current).not.toHaveBeenCalled();

    // HostKey 'info' and 'channel-list' toggle the corresponding sheets
    await act(async () => {
      live.hook.result.current.handleHostKey('info');
    });
    expect(live.hook.result.current.infoOpen).toBe(true);
    await act(async () => {
      live.hook.result.current.handleHostKey('channel-list');
    });
    expect(live.hook.result.current.channelListOpen).toBe(true);
    expect(live.hook.result.current.infoOpen).toBe(false);
    await act(async () => {
      live.hook.result.current.handleHostKey('channel-list');
    });
    expect(live.hook.result.current.channelListOpen).toBe(false);

    // When in 'progress' tier, Back hides progress OSD before exiting
    await act(async () => {
      live.hook.result.current.hideOsd();
      live.hook.result.current.stepVolumeBy(-5);
    });
    expect(live.hook.result.current.osdTier).toBe('progress');
    await act(async () => {
      live.hook.result.current.handleBack();
    });
    expect(live.hook.result.current.osdTier).toBe('hidden');
    expect(live.onExitRef.current).not.toHaveBeenCalled();

    // Next Back exits
    await act(async () => {
      live.hook.result.current.handleBack();
    });
    expect(live.onExitRef.current).toHaveBeenCalledTimes(1);

    await live.hook.unmount();
  });
});

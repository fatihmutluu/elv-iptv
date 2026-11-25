import { DEFAULT_SUBTITLE_STYLE, ok } from '@elv/domain';
import {
  createPlaybackService,
  EMPTY_TRACKS,
  type EngineEvent,
  type PlaybackClock,
  type PlaybackTimers,
  type PlayerEngine,
} from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import type { PlayTarget } from '../ports/play-target';
import { createAdoptedPlaybackService } from './adopted-playback-service';

function makeStubEngine() {
  const listeners = new Set<(event: EngineEvent) => void>();
  const engine: PlayerEngine & { emit(event: EngineEvent): void } = {
    capabilities: {
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: true,
      softwareAudioFallback: false,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
      audioDelay: true,
      subtitleDelay: true,
      videoQualitySelection: true,
      externalSubtitles: true,
      subtitleStyling: true,
      dualSubtitles: true,
      programSelection: true,
    },
    load: vi.fn(),
    retry: vi.fn(),
    recreate: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    jumpToLiveEdge: vi.fn(),
    setScrubbing: vi.fn(),
    setSpeed: vi.fn(),
    selectAudioTrack: vi.fn(),
    selectSubtitleTrack: vi.fn(),
    selectSecondarySubtitleTrack: vi.fn(),
    addExternalSubtitle: vi.fn(),
    setSubtitleStyle: vi.fn(),
    setAudioDelay: vi.fn(),
    setSubtitleDelay: vi.fn(),
    selectVideoQuality: vi.fn(),
    selectProgram: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    release: vi.fn(),
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
  return { engine, listeners };
}

const LIVE_TARGET: PlayTarget = {
  itemKey: 'live:src-1:101',
  sourceId: 'src-1',
  accountKey: 'acct-1',
  title: 'News HD',
  kind: 'live',
  itemKind: 'live',
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'vod:src-1:501',
  sourceId: 'src-1',
  accountKey: 'acct-1',
  title: 'Cinema Film',
  kind: 'vod',
  itemKind: 'movie',
};

describe('createAdoptedPlaybackService (Wave P3 zero-reload adoption)', () => {
  it('starts in playing state without calling engine.load and forwards commands using the engine attempt', () => {
    const { engine } = makeStubEngine();
    let nowMs = 1_000;
    const clock: PlaybackClock = { now: () => nowMs };
    const timers: PlaybackTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const service = createAdoptedPlaybackService({
      engine,
      clock,
      timers,
      target: VOD_TARGET,
      createDelegateService: () => createPlaybackService({ engine, clock, timers }),
    });

    expect(engine.load).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({
      status: { kind: 'playing' },
      item: 'vod:src-1:501',
      accountKey: 'acct-1',
      tracks: EMPTY_TRACKS,
    });

    const snapshots: string[] = [];
    const unsub = service.subscribe((s) => snapshots.push(s.status.kind));

    // Donor engine emits events with attempt = 4; adopted service syncs attempt without dropping them
    engine.emit({
      type: 'clock',
      attempt: 4,
      anchor: { positionMs: 30_000, atMs: 1_000, rate: 1, durationMs: 120_000 },
    });
    engine.emit({
      type: 'tracks',
      attempt: 4,
      tracks: {
        audio: [{ id: 'a1', label: 'English', language: 'en' }],
        subtitles: [{ id: 's1', label: 'Turkish', language: 'tr' }],
        selectedAudioId: 'a1',
        selectedSubtitleId: null,
        selectedVideoQualityId: '1080p',
      },
    });
    engine.emit({
      type: 'mediaInfo',
      attempt: 4,
      info: { width: 1920, height: 1080, fps: 50, codec: 'h264', droppedFrames: 2 },
    });
    engine.emit({
      type: 'chapters',
      attempt: 4,
      chapters: [{ id: 'c1', title: 'Intro', startMs: 0 }],
    });
    engine.emit({ type: 'telemetry', attempt: 4, droppedFrames: 5 });
    engine.emit({ type: 'externalPlayback', attempt: 4, active: true });

    expect(service.getState().attempt).toBe(4);
    expect(service.getState().tracks.audio).toHaveLength(1);
    expect(service.getState().videoInfo).toMatchObject({
      width: 1920,
      height: 1080,
      droppedFrames: 5,
    });
    expect(service.getState().chapters).toHaveLength(1);
    expect(service.getState().externalPlaybackActive).toBe(true);

    // Controls forward activeAttempt = 4
    service.pause();
    expect(engine.pause).toHaveBeenCalledWith(4);
    expect(service.getState().status.kind).toBe('paused');

    service.play();
    expect(engine.play).toHaveBeenCalledWith(4);
    expect(service.getState().status.kind).toBe('playing');

    nowMs = 2_000;
    service.seekBy?.(10_000);
    expect(engine.seek).toHaveBeenCalledWith(4, expect.any(Number));

    service.setSpeed(1.5);
    expect(engine.setSpeed).toHaveBeenCalledWith(4, 1.5);

    service.selectAudioTrack('a1');
    expect(engine.selectAudioTrack).toHaveBeenCalledWith(4, 'a1');

    service.selectSubtitleTrack('s1');
    expect(engine.selectSubtitleTrack).toHaveBeenCalledWith(4, 's1');

    service.selectSecondarySubtitleTrack('s2');
    expect(engine.selectSecondarySubtitleTrack).toHaveBeenCalledWith(4, 's2');

    service.setAudioDelay(120);
    expect(engine.setAudioDelay).toHaveBeenCalledWith(4, 120);
    expect(service.getState().audioDelayMs).toBe(120);

    service.setSubtitleDelay(-80);
    expect(engine.setSubtitleDelay).toHaveBeenCalledWith(4, -80);
    expect(service.getState().subtitleDelayMs).toBe(-80);

    service.selectVideoQuality('720p');
    expect(engine.selectVideoQuality).toHaveBeenCalledWith(4, '720p');
    expect(service.getState().selectedVideoQualityId).toBe('720p');

    service.selectProgram?.('prog-1');
    expect(engine.selectProgram).toHaveBeenCalledWith(4, 'prog-1');

    service.setScrubbing?.(true);
    expect(engine.setScrubbing).toHaveBeenCalledWith(4, true);

    expect(
      service.addExternalSubtitle({ id: 'ext-1', label: 'EN', uri: 'https://a.test/1.srt' }),
    ).toBe(true);
    expect(engine.addExternalSubtitle).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ id: 'ext-1' }),
    );

    service.setSubtitleStyle(DEFAULT_SUBTITLE_STYLE);
    expect(engine.setSubtitleStyle).toHaveBeenCalled();

    engine.emit({ type: 'error', attempt: 4, error: { code: 'network' } });
    expect(service.getState().status.kind).toBe('failed');

    service.retry();
    expect(engine.retry).toHaveBeenCalledWith(4);
    expect(service.getState().status.kind).toBe('tuning');

    unsub();
    expect(snapshots.length).toBeGreaterThan(0);

    service.dispose();
    expect(engine.stop).toHaveBeenCalledWith(4);
  });

  it('supports live jumpToLiveEdge and seamlessly upgrades to full PlaybackService on tune()', async () => {
    const { engine, listeners } = makeStubEngine();
    const clock: PlaybackClock = { now: () => 5_000 };
    const timers: PlaybackTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const delegate = createPlaybackService({ engine, clock, timers });
    const createDelegateService = vi.fn(() => delegate);

    const service = createAdoptedPlaybackService({
      engine,
      clock,
      timers,
      target: LIVE_TARGET,
      createDelegateService,
    });

    engine.emit({
      type: 'clock',
      attempt: 2,
      anchor: {
        positionMs: 10_000,
        atMs: 5_000,
        rate: 1,
        liveEdgeMs: 25_000,
        liveSeekableStartMs: 0,
        timeShiftSupported: true,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(true);
    expect(engine.jumpToLiveEdge).toHaveBeenCalledWith(2);

    const onChange = vi.fn();
    service.subscribe(onChange);

    // Triggering tune() upgrades to delegate PlaybackService
    service.tune({
      item: 'live:src-1:102',
      accountKey: 'acct-1',
      kind: 'live',
      resolve: async () =>
        ok({
          url: 'http://sim.example.test/live-102.m3u8',
          kind: 'live' as const,
          headers: {},
          sourceId: 'src-1',
        }),
    });

    expect(createDelegateService).toHaveBeenCalledTimes(1);
    expect(service.getState().item).toBe('live:src-1:102');
    expect(service.getState().status.kind).toBe('tuning');
    expect(onChange).toHaveBeenCalled();

    service.dispose();
    expect(listeners.size).toBe(0);
  });

  it('handles adoptQueuedTarget in-place while staying on activeAttempt without delegating to an idle PlaybackService', () => {
    const { engine } = makeStubEngine();
    let nowMs = 10_000;
    const clock: PlaybackClock = { now: () => nowMs };
    const timers: PlaybackTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const createDelegateService = vi.fn(() => createPlaybackService({ engine, clock, timers }));

    const service = createAdoptedPlaybackService({
      engine,
      clock,
      timers,
      target: VOD_TARGET,
      createDelegateService,
    });

    // Hydrate Episode 1 state on attempt = 7
    engine.emit({
      type: 'clock',
      attempt: 7,
      anchor: { positionMs: 2_400_000, atMs: 10_000, rate: 1, durationMs: 2_405_000 },
    });
    engine.emit({
      type: 'tracks',
      attempt: 7,
      tracks: {
        audio: [{ id: 'a1', label: 'EN', language: 'en' }],
        subtitles: [{ id: 's1', label: 'EN', language: 'en' }],
        selectedAudioId: 'a1',
        selectedSubtitleId: 's1',
        selectedVideoQualityId: '1080p',
      },
    });
    engine.emit({
      type: 'mediaInfo',
      attempt: 7,
      info: { width: 1920, height: 1080, fps: 24, codec: 'hevc', droppedFrames: 3 },
    });
    service.setAudioDelay(150);
    service.setSubtitleDelay(-50);

    // Gapless queue advances to Episode 2 on the same live attempt = 7
    nowMs = 15_000;
    const listener = vi.fn();
    service.subscribe(listener);
    service.adoptQueuedTarget(
      {
        item: 'vod:src-1:502',
        accountKey: 'acct-1',
        kind: 'vod',
        startMs: 0,
        subtitleStyle: DEFAULT_SUBTITLE_STYLE,
        resolve: async () =>
          ok({
            url: 'http://sim.example.test/ep2.mkv',
            kind: 'vod' as const,
            headers: {},
            sourceId: 'src-1',
          }),
      },
      {
        url: 'http://sim.example.test/ep2.mkv',
        headers: {},
        sourceId: 'src-1',
      },
    );

    expect(createDelegateService).not.toHaveBeenCalled();
    expect(engine.load).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    const next = service.getState();
    expect(next).toMatchObject({
      status: { kind: 'playing' },
      attempt: 7,
      item: 'vod:src-1:502',
      accountKey: 'acct-1',
      tuneAt: 15_000,
      tracks: EMPTY_TRACKS,
      audioDelayMs: 0,
      subtitleDelayMs: 0,
      selectedVideoQualityId: null,
    });
    expect(next.anchor).toBeUndefined();
    expect(next.videoInfo).toBeUndefined();
    expect(next.chapters).toBeUndefined();
    expect(next.droppedFrames).toBeUndefined();

    // Transport commands & incoming events still work on activeAttempt = 7
    service.pause();
    expect(engine.pause).toHaveBeenCalledWith(7);
    expect(service.getState().status.kind).toBe('paused');

    engine.emit({
      type: 'clock',
      attempt: 7,
      anchor: { positionMs: 5_000, atMs: 15_500, rate: 1, durationMs: 2_600_000 },
    });
    expect(service.getState().anchor?.positionMs).toBe(5_000);

    service.dispose();
  });
});

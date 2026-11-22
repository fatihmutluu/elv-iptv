import type { EngineEvent } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { createMpvEngine } from '../engine.ts';
import { createFakeMpv, type FakeMpvScript } from './fake-mpv.ts';
import { createMpvTelemetry, PROGRESS_THROTTLE_MS } from './telemetry.ts';

describe('createMpvTelemetry', () => {
  it('emits throttled progress events only when cache bytes or duration advance while waiting (#314)', () => {
    const telemetry = createMpvTelemetry();

    // First cache advance during opening emits immediately
    expect(
      telemetry.onCacheState({ 'fw-bytes': 65_536, 'cache-duration': 1.2 }, 1_000, true),
    ).toEqual({ type: 'progress', bytesReceived: 65_536, atMs: 1_000 });

    // Within throttle window (500ms) does not emit even if bytes grow
    expect(
      telemetry.onCacheState(
        { 'fw-bytes': 131_072, 'cache-duration': 2.0 },
        1_000 + PROGRESS_THROTTLE_MS - 1,
        true,
      ),
    ).toBeUndefined();

    // Past throttle window with advanced bytes emits once
    expect(
      telemetry.onCacheState(
        { 'fw-bytes': 196_608, 'cache-duration': 3.0 },
        1_000 + PROGRESS_THROTTLE_MS,
        true,
      ),
    ).toEqual({ type: 'progress', bytesReceived: 196_608, atMs: 1_500 });

    // Past throttle window with NO advance (stalled socket) emits nothing
    expect(
      telemetry.onCacheState({ 'fw-bytes': 196_608, 'cache-duration': 3.0 }, 2_500, true),
    ).toBeUndefined();

    // During steady playback (waiting = false), baseline tracks current buffer without emitting
    expect(
      telemetry.onCacheState({ 'fw-bytes': 524_288, 'cache-duration': 8.0 }, 3_500, false),
    ).toBeUndefined();

    // Entering waiting=true with static or shrinking cache emits ZERO progress
    expect(
      telemetry.onCacheState({ 'fw-bytes': 524_288, 'cache-duration': 8.0 }, 4_100, true),
    ).toBeUndefined();
    expect(
      telemetry.onCacheState({ 'fw-bytes': 120_000, 'cache-duration': 1.5 }, 4_700, true),
    ).toBeUndefined();

    // Refilling after a seek/cache drain below previous high-water mark emits progress with monotonic cumulative bytes
    expect(
      telemetry.onCacheState({ 'fw-bytes': 185_536, 'cache-duration': 2.4 }, 5_300, true),
    ).toEqual({
      type: 'progress',
      bytesReceived: 524_288 + (185_536 - 120_000),
      atMs: 5_300,
    });

    // Duration-only advance via demuxer-cache-duration during stall emits pure advancement signal (no flat bytesReceived)
    expect(telemetry.onCacheDuration(3.6, 5_900, true)).toEqual({
      type: 'progress',
      atMs: 5_900,
    });

    // Static or shrinking demuxer-cache-duration emits nothing
    expect(telemetry.onCacheDuration(3.6, 6_500, true)).toBeUndefined();
    expect(telemetry.onCacheDuration(2.0, 7_100, true)).toBeUndefined();
  });

  it('tracks hasVideoTrack and decodedVideoFrames across video, black-screen, and audio-only streams (#321)', () => {
    const video = createMpvTelemetry();
    video.onTrackList([
      { id: 1, type: 'video', selected: true },
      { id: 1, type: 'audio', selected: true },
    ]);
    // Video track selected but no frames decoded yet -> reports 0 frames
    expect(video.clockFields(1_000, 1)).toEqual({ hasVideoTrack: true, decodedVideoFrames: 0 });

    // Positive estimated-vf-fps accumulates rendered frames while playing
    video.onEstimatedVfFps(30, 1_000);
    const first = video.clockFields(2_000, 1);
    expect(first.hasVideoTrack).toBe(true);
    expect(first.decodedVideoFrames).toBeGreaterThanOrEqual(30);

    // Paused (rate = 0) holds frame count steady without incrementing
    const paused = video.clockFields(5_000, 0);
    expect(paused.decodedVideoFrames).toBe(first.decodedVideoFrames);

    // Zero fps on a video stream keeps decodedVideoFrames at 0
    const blackScreen = createMpvTelemetry();
    blackScreen.onVid(1, true);
    blackScreen.onVideoParams({ w: 1920, h: 1080 });
    blackScreen.onEstimatedVfFps(0, 1_000);
    expect(blackScreen.clockFields(2_000, 1)).toEqual({
      hasVideoTrack: true,
      decodedVideoFrames: 0,
    });

    // Audio-only stream reports hasVideoTrack: false and no decodedVideoFrames
    const radio = createMpvTelemetry();
    radio.onTrackList([{ id: 1, type: 'audio', selected: true }]);
    radio.onVid(false, true);
    expect(radio.clockFields(2_000, 1)).toEqual({ hasVideoTrack: false });
  });
});

describe('createMpvEngine telemetry wiring (#314, #321)', () => {
  it('emits progress during opening/stall and carries hasVideoTrack/decodedVideoFrames on clock anchors', async () => {
    const url = 'http://sim/movie/demo/demo/1.mkv';
    const script: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      {
        afterMs: 1,
        property: 'demuxer-cache-state',
        value: { 'fw-bytes': 32_768, 'cache-duration': 0.8 },
      },
      { afterMs: 2, event: 'file-loaded' },
      {
        afterMs: 3,
        property: 'track-list',
        value: [
          { id: 1, type: 'video', codec: 'hevc', selected: true },
          { id: 1, type: 'audio', codec: 'aac', lang: 'eng', selected: true },
        ],
      },
      { afterMs: 4, property: 'vid', value: 1 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'estimated-vf-fps', value: 24 },
      { afterMs: 7, property: 'time-pos', value: 0 },
      { afterMs: 8, event: 'playback-restart' },
    ];
    const fake = createFakeMpv({ scripts: { [url]: script }, transport: 'socket' });
    let nowMs = 10_000;
    const events: EngineEvent[] = [];
    const engine = createMpvEngine({
      spawn: (args, signal) => fake.spawn(args, signal),
      presenter: {
        kind: 'child-window',
        prepare: async () => [],
        attach: () => undefined,
        setArea: () => undefined,
        coversArea: false,
        toggleFullscreen: () => undefined,
        onEvent: () => () => undefined,
        dispose: () => undefined,
      },
      baseArgs: [],
      loadMode: 'replace',
      now: () => {
        nowMs += 600;
        return nowMs;
      },
      timers: { setTimeout, clearTimeout },
      onUi: () => undefined,
    });
    const off = engine.subscribe((e) => events.push(e));
    try {
      engine.load({ attempt: 5, url, headers: {}, kind: 'vod' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({ attempt: 5, type: 'progress', bytesReceived: 32_768 });

      const clockEvents = events.filter((e) => e.type === 'clock');
      expect(clockEvents.length).toBeGreaterThanOrEqual(1);
      expect(clockEvents[0]).toMatchObject({
        attempt: 5,
        type: 'clock',
        anchor: { hasVideoTrack: true },
      });
      const frames =
        clockEvents[0]?.type === 'clock' ? clockEvents[0].anchor.decodedVideoFrames : 0;
      expect(frames).toBeGreaterThan(0);
    } finally {
      off();
      engine.release();
      await fake.dispose();
    }
  });
});

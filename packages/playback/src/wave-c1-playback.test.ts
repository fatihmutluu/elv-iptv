import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterInfo } from './engine';
import {
  bridgeNativeEngine,
  type NativeEngineHandle,
  type NativeLoadCommand,
} from './native-bridge';
import { error, playing, rig, tick, vod } from './recovery-test-helpers';

describe('Wave C1 playback chapters, telemetry, load options, and ladder (#118, #124, #160, #310)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores chapters and droppedFrames telemetry on PlaybackState and resets them on new tune/stop', async () => {
    const r = rig({});
    await playing(
      r,
      vod('movie:1', {
        preferHevcOverDolbyVision: true,
        filterSdhSubtitles: true,
      }),
    );

    expect(r.loads[0]?.options).toMatchObject({
      preferHevcOverDolbyVision: true,
      filterSdhSubtitles: true,
    });

    const attempt = r.service.getState().attempt;
    const chapters: readonly ChapterInfo[] = [
      { id: 'ch-1', title: 'Intro', startMs: 0, endMs: 90_000 },
      { id: 'ch-2', title: 'Act I', startMs: 90_000, endMs: 600_000 },
    ];
    r.engine.emit({ attempt, type: 'chapters', chapters });
    r.engine.emit({ attempt, type: 'telemetry', droppedFrames: 7 });
    expect(r.service.getState().chapters).toEqual(chapters);
    expect(r.service.getState().droppedFrames).toBe(7);

    r.engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, droppedFrames: 12 },
    });
    expect(r.service.getState().videoInfo?.droppedFrames).toBe(12);
    expect(r.service.getState().droppedFrames).toBe(12);

    // telemetry event also updates videoInfo.droppedFrames when videoInfo exists
    r.engine.emit({ attempt, type: 'telemetry', droppedFrames: 19 });
    expect(r.service.getState().droppedFrames).toBe(19);
    expect(r.service.getState().videoInfo?.droppedFrames).toBe(19);

    // stop resets chapters and droppedFrames
    r.service.stop();
    expect(r.service.getState().chapters).toBeUndefined();
    expect(r.service.getState().droppedFrames).toBeUndefined();

    // New tune also resets chapters and droppedFrames
    await playing(r, vod('movie:2'));
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'chapters',
      chapters,
    });
    r.engine.emit({
      attempt: r.service.getState().attempt,
      type: 'telemetry',
      droppedFrames: 3,
    });
    r.service.tune(vod('movie:3'));
    expect(r.service.getState().chapters).toBeUndefined();
    expect(r.service.getState().droppedFrames).toBeUndefined();

    r.service.dispose();
  });

  it('forwards filterSdhSubtitles through bridgeNativeEngine to NativeLoadCommand', () => {
    const received: NativeLoadCommand[] = [];
    const native: NativeEngineHandle = {
      load: (cmd) => received.push(cmd),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      addListener: () => ({ remove: vi.fn() }),
    };
    const bridged = bridgeNativeEngine(native, {
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: false,
        softwareAudioFallback: true,
        recreate: true,
        audioTrackSelection: true,
        subtitleTrackSelection: true,
      },
      uptimeMs: () => 100,
      now: () => 1000,
    });
    bridged.load({
      attempt: 1,
      url: 'https://example.test/v.mkv',
      headers: {},
      kind: 'vod',
      options: { filterSdhSubtitles: true, preferHevcOverDolbyVision: true },
    });
    expect(received[0]).toMatchObject({
      filterSdhSubtitles: true,
      preferHevcOverDolbyVision: true,
    });
  });

  it('enables preferHevcOverDolbyVision on Rung 2+ recovery reloads after decoder errors (#124)', async () => {
    const r = rig({ 'movie:dv': [] }, { softwareAudioFallback: true, recreate: true });
    await playing(r, vod('movie:dv'));

    expect(r.loads).toHaveLength(1);
    expect(r.loads[0]?.options?.preferHevcOverDolbyVision).toBeUndefined();

    // First decoder error -> Rung 1 (retry); second decoder error -> Rung 2 (reload with preferHevcOverDolbyVision: true)
    error(r, 'decoder');
    error(r, 'decoder');
    await tick(1_000);

    expect(r.loads.length).toBeGreaterThanOrEqual(2);
    expect(r.loads[1]?.options?.preferHevcOverDolbyVision).toBe(true);

    // Third decoder error -> Rung 3 (recreate + reload with preferHevcOverDolbyVision: true)
    error(r, 'decoder');
    await tick(2_000);
    expect(r.loads.length).toBeGreaterThanOrEqual(3);
    expect(r.loads[2]?.options?.preferHevcOverDolbyVision).toBe(true);

    r.service.dispose();
  });

  it('clears stale videoInfo.droppedFrames on retry and recovery reload (#160)', async () => {
    const r = rig({ 'movie:df': [] });
    await playing(r, vod('movie:df'));
    const attempt = r.service.getState().attempt;
    r.engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, droppedFrames: 42 },
    });
    r.engine.emit({ attempt, type: 'telemetry', droppedFrames: 42 });
    expect(r.service.getState().droppedFrames).toBe(42);
    expect(r.service.getState().videoInfo?.droppedFrames).toBe(42);

    r.service.retry();
    await tick(10);
    expect(r.service.getState().droppedFrames).toBeUndefined();
    expect(r.service.getState().videoInfo?.droppedFrames).toBeUndefined();
    r.service.dispose();
  });
});

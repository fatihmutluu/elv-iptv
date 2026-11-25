import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  bridgeNativeEngine,
  createPlaybackService,
  type EngineEvent,
  filterTracksByProgram,
  hasMultiplePrograms,
  type MediaTracks,
  type NativeEngineHandle,
  type PlayerEngine,
} from './index';

describe('programs (#304)', () => {
  const multiProgramTracks: MediaTracks = {
    programs: [
      { id: '101', label: 'Program 101', serviceName: 'News HD', programNumber: 101 },
      { id: '102', label: 'Program 102', serviceName: 'Sports HD', programNumber: 102 },
    ],
    selectedProgramId: '101',
    audio: [
      { id: 'a1', language: 'en', programId: '101' },
      { id: 'a2', language: 'tr', programId: '102' },
    ],
    subtitles: [
      { id: 's1', language: 'en', programId: '101' },
      { id: 's2', language: 'tr', programId: '102' },
      { id: 'ext-1', language: 'fr', external: true },
    ],
    videoQualities: [
      { id: 'v1', label: '1080p', height: 1080, programId: '101' },
      { id: 'v2', label: '720p', height: 720, programId: '102' },
    ],
    selectedAudioId: 'a1',
    selectedSubtitleId: 's1',
  };

  it('detects whether multiple programs are present', () => {
    expect(hasMultiplePrograms(multiProgramTracks)).toBe(true);
    expect(
      hasMultiplePrograms({
        ...multiProgramTracks,
        programs: [{ id: '101', label: 'Only One' }],
      }),
    ).toBe(false);
    expect(
      hasMultiplePrograms({
        audio: [],
        subtitles: [],
        selectedAudioId: null,
        selectedSubtitleId: null,
      }),
    ).toBe(false);
  });

  it('filters audio, subtitles (preserving external), and videoQualities to selectedProgramId', () => {
    const filtered = filterTracksByProgram(multiProgramTracks);
    expect(filtered.audio.map((t) => t.id)).toEqual(['a1']);
    expect(filtered.subtitles.map((t) => t.id)).toEqual(['s1', 'ext-1']);
    expect(filtered.videoQualities?.map((v) => v.id)).toEqual(['v1']);
  });

  it('keeps tracks unchanged when <= 1 program, selectedProgramId is unset, or tracks lack programId', () => {
    const singleProgram: MediaTracks = {
      ...multiProgramTracks,
      programs: [{ id: '101', label: 'Single' }],
    };
    expect(filterTracksByProgram(singleProgram)).toBe(singleProgram);

    const noSelection: MediaTracks = {
      ...multiProgramTracks,
      selectedProgramId: null,
    };
    expect(filterTracksByProgram(noSelection)).toBe(noSelection);

    const untaggedTracks: MediaTracks = {
      programs: [
        { id: '101', label: 'Program 101' },
        { id: '102', label: 'Program 102' },
      ],
      selectedProgramId: '101',
      audio: [
        { id: 'a1', language: 'en' },
        { id: 'a2', language: 'tr' },
      ],
      subtitles: [{ id: 's1', language: 'en' }],
      selectedAudioId: 'a1',
      selectedSubtitleId: null,
    };
    const result = filterTracksByProgram(untaggedTracks);
    expect(result.audio.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(result.subtitles.map((t) => t.id)).toEqual(['s1']);
  });
});

describe('native-bridge & PlaybackService multi-program support (#304)', () => {
  it('preserves programs, selectedProgramId, and track.programId through bridgeNativeEngine and forwards selectProgram', () => {
    let emit: ((event: EngineEvent) => void) | undefined;
    const selectProgram = vi.fn();
    const load = vi.fn();
    const native: NativeEngineHandle = {
      load,
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      selectProgram,
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      addListener: (_name, listener) => {
        emit = listener;
        return { remove: vi.fn() };
      },
    };

    const engine = bridgeNativeEngine(native, {
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: false,
        softwareAudioFallback: false,
        recreate: true,
        audioTrackSelection: true,
        subtitleTrackSelection: true,
        programSelection: true,
      },
      uptimeMs: () => 1000,
      now: () => 5000,
    });

    const received: EngineEvent[] = [];
    engine.subscribe((e) => received.push(e));
    engine.load({
      attempt: 1,
      url: 'http://sim.test/live/multi.ts',
      headers: {},
      kind: 'live',
      options: { programId: '102' },
    });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ programId: '102' }));

    emit?.({
      attempt: 1,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a1', language: 'en', programId: '101' }],
        subtitles: [{ id: 's1', language: 'en', programId: '101' }],
        selectedAudioId: 'a1',
        selectedSubtitleId: null,
        programs: [
          { id: '101', label: 'News', serviceName: 'News HD', programNumber: 101 },
          { id: '  ', label: 'Invalid' },
          { id: '102', label: 'Sports', programNumber: 102 },
        ],
        selectedProgramId: '101',
        videoQualities: [{ id: 'v1', label: '1080p', height: 1080, programId: '101' }],
      },
    });

    expect(received).toHaveLength(1);
    const tracksEvt = received[0];
    expect(tracksEvt?.type).toBe('tracks');
    if (tracksEvt?.type === 'tracks') {
      expect(tracksEvt.tracks.programs).toEqual([
        { id: '101', label: 'News', serviceName: 'News HD', programNumber: 101 },
        { id: '102', label: 'Sports', programNumber: 102 },
      ]);
      expect(tracksEvt.tracks.selectedProgramId).toBe('101');
      expect(tracksEvt.tracks.audio[0]?.programId).toBe('101');
      expect(tracksEvt.tracks.videoQualities?.[0]?.programId).toBe('101');
    }

    engine.selectProgram?.(2, '102');
    expect(selectProgram).toHaveBeenCalledWith(2, '102');
  });

  it('forwards PlaybackService.selectProgram with the current attempt token when loaded', async () => {
    const selectProgram = vi.fn();
    const listeners = new Set<(e: EngineEvent) => void>();
    const engine: PlayerEngine = {
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: false,
        softwareAudioFallback: false,
        recreate: false,
        audioTrackSelection: true,
        subtitleTrackSelection: true,
        programSelection: true,
      },
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      selectProgram,
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    const service = createPlaybackService({
      engine,
      clock: { now: () => 1000 },
      timers: {
        setTimeout: () => 1,
        clearTimeout: () => {},
      },
    });

    // No-op while idle
    service.selectProgram?.('101');
    expect(selectProgram).not.toHaveBeenCalled();

    const attempt = service.tune({
      item: 'ch-1',
      accountKey: 'acc-1',
      kind: 'live',
      resolve: () => Promise.resolve(ok({ url: 'http://sim.test/live/multi.ts', headers: {} })),
    });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    service.selectProgram?.(' 102 ');
    expect(selectProgram).toHaveBeenCalledWith(attempt, '102');

    // Blank ID is ignored
    service.selectProgram?.('   ');
    expect(selectProgram).toHaveBeenCalledTimes(1);

    service.dispose();
  });
});

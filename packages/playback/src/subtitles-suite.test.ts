import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyleConfig } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCapabilities, EngineEvent, ExternalSubtitleTrack, LoadCommand } from './engine';
import {
  inferSubtitleMimeType,
  isAllowedExternalSubtitleUri,
  MAX_EXTERNAL_SUBTITLE_URI_LENGTH,
  normalizeExternalSubtitleTrack,
  sanitizeExternalSubtitleHeaders,
} from './external-subtitles';
import { bridgeNativeEngine, type NativeEngineHandle } from './native-bridge';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing/fake-engine';
import type { PlaybackState, TuneRequest } from './types';

function makeHarness() {
  let now = 1_000;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const schedule = (fn: () => void, ms: number): number => {
    const id = nextTimerId++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const cancel = (handle: unknown): void => {
    if (typeof handle === 'number') timers.delete(handle);
  };
  const flushTimers = (advanceMs = 0): void => {
    now += advanceMs;
    for (const [id, entry] of [...timers]) {
      if (entry.at <= now) {
        timers.delete(id);
        entry.fn();
      }
    }
  };
  const loads: LoadCommand[] = [];
  const rawEngine = createFakePlayerEngine({
    now: () => now,
    schedule,
    cancel,
    capabilities: {
      externalSubtitles: true,
      subtitleStyling: true,
      dualSubtitles: true,
    },
  });
  const engine = {
    ...rawEngine,
    load(cmd: LoadCommand) {
      loads.push(cmd);
      rawEngine.load(cmd);
    },
  };
  const service = createPlaybackService({
    engine,
    clock: { now: () => now },
    timers: { setTimeout: schedule, clearTimeout: cancel },
  });
  return { engine: rawEngine, loads, service, flushTimers };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeRequest(
  item = 'movie:1',
  url = 'https://stream.example.com/vod/1.m3u8',
  extra: Partial<TuneRequest> = {},
): TuneRequest {
  return {
    item,
    accountKey: 'acct-1',
    kind: 'vod',
    resolve: async () => ({
      ok: true,
      value: {
        url,
        headers: {
          Authorization: 'Bearer stream-secret',
          Cookie: 'session=stream-cookie',
          'User-Agent': 'StreamUA/1.0',
        },
      },
    }),
    ...extra,
  };
}

describe('external-subtitles helpers (#308, #32)', () => {
  it('allows http, https, file, and content URIs and rejects unsafe or malformed URIs', () => {
    expect(isAllowedExternalSubtitleUri('https://subs.example.com/movie.vtt')).toBe(true);
    expect(isAllowedExternalSubtitleUri('HTTP://subs.example.com:8080/movie.srt?lang=en')).toBe(
      true,
    );
    expect(isAllowedExternalSubtitleUri('file:///storage/emulated/0/Download/movie.ass')).toBe(
      true,
    );
    expect(
      isAllowedExternalSubtitleUri('content://com.android.externalstorage.documents/sub.ttml'),
    ).toBe(true);
    expect(isAllowedExternalSubtitleUri('  https://subs.example.com/trimmed.srt  ')).toBe(true);

    expect(isAllowedExternalSubtitleUri('')).toBe(false);
    expect(isAllowedExternalSubtitleUri('   ')).toBe(false);
    expect(isAllowedExternalSubtitleUri('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalSubtitleUri('javascript://alert(1)')).toBe(false);
    expect(isAllowedExternalSubtitleUri('data:text/vtt;base64,V0VCVlRU')).toBe(false);
    expect(isAllowedExternalSubtitleUri('ftp://subs.example.com/movie.srt')).toBe(false);
    expect(isAllowedExternalSubtitleUri('/local/path/movie.srt')).toBe(false);
    expect(isAllowedExternalSubtitleUri('https://')).toBe(false);
    expect(isAllowedExternalSubtitleUri('file://')).toBe(false);
    expect(isAllowedExternalSubtitleUri('content://   ')).toBe(false);
    expect(isAllowedExternalSubtitleUri('https://subs.example.com/a.srt\r\nX-Inject: 1')).toBe(
      false,
    );
    expect(isAllowedExternalSubtitleUri('https://subs.example.com/a\u0000.srt')).toBe(false);
    expect(isAllowedExternalSubtitleUri('https://subs.example.com/a\u007f.srt')).toBe(false);
    expect(
      isAllowedExternalSubtitleUri(
        `https://subs.example.com/${'a'.repeat(MAX_EXTERNAL_SUBTITLE_URI_LENGTH)}`,
      ),
    ).toBe(false);
  });

  it('infers canonical subtitle MIME types from explicit MIME or URI extension', () => {
    expect(inferSubtitleMimeType('https://subs.example.com/a.vtt')).toBe('text/vtt');
    expect(inferSubtitleMimeType('https://subs.example.com/a.webvtt?dl=1#cue')).toBe('text/vtt');
    expect(inferSubtitleMimeType('file:///tmp/movie.SRT')).toBe('application/x-subrip');
    expect(inferSubtitleMimeType('file:///tmp/movie.ass')).toBe('text/x-ssa');
    expect(inferSubtitleMimeType('file:///tmp/movie.ssa')).toBe('text/x-ssa');
    expect(inferSubtitleMimeType('https://subs.example.com/a.ttml')).toBe('application/ttml+xml');
    expect(inferSubtitleMimeType('https://subs.example.com/a.dfxp')).toBe('application/ttml+xml');
    expect(inferSubtitleMimeType('https://subs.example.com/a.xml')).toBe('application/ttml+xml');
    expect(inferSubtitleMimeType('https://subs.example.com/no-ext')).toBe('application/x-subrip');

    expect(
      inferSubtitleMimeType('https://subs.example.com/dl?id=1', 'TEXT/VTT; charset=utf-8'),
    ).toBe('text/vtt');
    expect(inferSubtitleMimeType('https://subs.example.com/dl?id=1', 'text/srt')).toBe(
      'application/x-subrip',
    );
    expect(inferSubtitleMimeType('https://subs.example.com/dl?id=1', 'text/x-ass\r\n')).toBe(
      'text/x-ssa',
    );
    expect(inferSubtitleMimeType('https://subs.example.com/dl?id=1', 'application/ttaf+xml')).toBe(
      'application/ttml+xml',
    );
    expect(
      inferSubtitleMimeType('https://subs.example.com/sub.vtt', 'application/octet-stream'),
    ).toBe('text/vtt');
    expect(inferSubtitleMimeType('https://subs.example.com/sub.ass', 'invalid mime')).toBe(
      'text/x-ssa',
    );
    expect(inferSubtitleMimeType('https://subs.example.com/dl', 'text/plain')).toBe('text/plain');
  });

  it('sanitizes external subtitle headers in complete isolation from stream headers', () => {
    expect(sanitizeExternalSubtitleHeaders(undefined)).toEqual({});
    const clean = sanitizeExternalSubtitleHeaders({
      'X-Sub-Key': 'token-123\r\nX-Injected: yes',
      'Bad Header': 'ignored',
      'X-Empty': '   \n  ',
      Accept: 'text/vtt',
    });
    expect(clean).toEqual({
      'X-Sub-Key': 'token-123X-Injected: yes',
      Accept: 'text/vtt',
    });
  });

  it('normalizes valid external subtitle tracks and rejects invalid ones', () => {
    expect(
      normalizeExternalSubtitleTrack({
        id: '   ',
        uri: 'https://subs.example.com/a.vtt',
      }),
    ).toBeNull();
    expect(
      normalizeExternalSubtitleTrack({
        id: 'ext:1',
        uri: 'javascript:alert(1)',
      }),
    ).toBeNull();

    const normalized = normalizeExternalSubtitleTrack({
      id: '  ext:1\r\n  ',
      uri: '  https://subs.example.com/en.vtt?v=1  ',
      label: `  English\u0007 ${'x'.repeat(200)}`,
      language: ` en-US\n${'y'.repeat(50)}`,
      headers: {
        'X-Sub-Token': 'sub-only',
        'Invalid Name': 'drop',
      },
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.id).toBe('ext:1');
    expect(normalized?.uri).toBe('https://subs.example.com/en.vtt?v=1');
    expect(normalized?.mimeType).toBe('text/vtt');
    expect(normalized?.label?.length).toBeLessThanOrEqual(128);
    expect(normalized?.label).not.toContain('\u0007');
    expect(normalized?.language?.length).toBeLessThanOrEqual(32);
    expect(normalized?.language).not.toContain('\n');
    expect(normalized?.headers).toEqual({ 'X-Sub-Token': 'sub-only' });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized?.headers)).toBe(true);

    const noHeaders = normalizeExternalSubtitleTrack({
      id: 'ext:2',
      uri: 'file:///subs/tr.srt',
    });
    expect(noHeaders).toEqual({
      id: 'ext:2',
      uri: 'file:///subs/tr.srt',
      mimeType: 'application/x-subrip',
    });
    expect(noHeaders).not.toHaveProperty('headers');
  });
});

describe('PlaybackService external subtitles, live style, and dual subtitles (#308, #32, #402)', () => {
  it('validates, deduplicates, isolates headers, retains across recovery reload, and clears on tune/stop', async () => {
    const { engine, loads, service, flushTimers } = makeHarness();

    expect(
      service.addExternalSubtitle({ id: 'ext:idle', uri: 'https://subs.example.com/idle.srt' }),
    ).toBe(false);

    service.tune(
      makeRequest('movie:1', 'https://stream.example.com/vod/1.m3u8', {
        externalSubtitles: [
          {
            id: 'ext:init',
            uri: 'https://subs.example.com/init.vtt',
            label: 'Initial VTT',
            language: 'en',
          },
          { id: 'ext:bad', uri: 'data:text/vtt,WEBVTT' },
          { id: 'ext:dup-uri', uri: 'https://subs.example.com/init.vtt' },
        ],
      }),
    );
    await flushMicrotasks();
    flushTimers(300);

    const expectedInit = [
      {
        id: 'ext:init',
        uri: 'https://subs.example.com/init.vtt',
        label: 'Initial VTT',
        language: 'en',
        mimeType: 'text/vtt',
      },
    ];
    expect(service.getState().externalSubtitles).toEqual(expectedInit);
    expect(loads[0]?.headers).toEqual({
      Authorization: 'Bearer stream-secret',
      Cookie: 'session=stream-cookie',
      'User-Agent': 'StreamUA/1.0',
    });
    expect(loads[0]?.options?.externalSubtitles).toEqual(expectedInit);
    expect(loads[0]?.options?.externalSubtitles?.[0]?.headers).toBeUndefined();

    expect(
      service.addExternalSubtitle({
        id: 'ext:live',
        uri: 'https://subs.example.com/tr.ass',
        label: 'Turkish ASS',
        language: 'tr',
        headers: { 'X-Sub-Auth': 'sub-token' },
      }),
    ).toBe(true);
    expect(
      service.addExternalSubtitle({ id: 'ext:live', uri: 'https://subs.example.com/other.srt' }),
    ).toBe(false);
    expect(
      service.addExternalSubtitle({ id: 'ext:diff-id', uri: 'https://subs.example.com/tr.ass' }),
    ).toBe(false);
    expect(service.addExternalSubtitle({ id: 'ext:evil', uri: 'javascript:alert(1)' })).toBe(false);

    expect(engine.commands.filter((c) => c.name === 'addExternalSubtitle')).toEqual([
      {
        name: 'addExternalSubtitle',
        attempt: 1,
        externalSubtitle: {
          id: 'ext:live',
          uri: 'https://subs.example.com/tr.ass',
          label: 'Turkish ASS',
          language: 'tr',
          mimeType: 'text/x-ssa',
          headers: { 'X-Sub-Auth': 'sub-token' },
        },
      },
    ]);
    expect(service.getState().externalSubtitles).toHaveLength(2);

    // Trigger VOD network recovery reload -> both external subtitles retained in LoadOptions
    engine.emit({ attempt: 1, type: 'error', error: { code: 'network', detail: 'drop' } });
    flushTimers(2_000);

    expect(loads).toHaveLength(2);
    const recoveryLoad = loads.at(-1);
    expect(recoveryLoad?.attempt).toBe(2);
    expect(recoveryLoad?.options?.externalSubtitles).toHaveLength(2);
    expect(recoveryLoad?.options?.externalSubtitles?.[1]?.headers).toEqual({
      'X-Sub-Auth': 'sub-token',
    });

    // Next tune clears external subtitles
    service.tune(makeRequest('movie:2', 'https://stream.example.com/vod/2.m3u8'));
    expect(service.getState().externalSubtitles).toBeUndefined();
    await flushMicrotasks();
    flushTimers(300);
    expect(loads.at(-1)?.options?.externalSubtitles).toBeUndefined();

    // Add one then stop() -> clears external subtitles
    expect(
      service.addExternalSubtitle({
        id: 'ext:temp',
        uri: 'file:///tmp/temp.srt',
      }),
    ).toBe(true);
    expect(service.getState().externalSubtitles).toHaveLength(1);
    service.stop();
    expect(service.getState().externalSubtitles).toBeUndefined();
  });

  it('applies live setSubtitleStyle without restarting playback and forwards it on future loads (#32)', async () => {
    const { engine, loads, service, flushTimers } = makeHarness();
    const seen: PlaybackState[] = [];
    service.subscribe((st) => seen.push(st));

    const customStyle: SubtitleStyleConfig = {
      fontSize: 'large',
      textColor: 'yellow',
      backgroundColor: 'opaque',
      edgeStyle: 'dropShadow',
      verticalPosition: 'raised',
    };

    // Can set style while idle (persisted preference hydration)
    service.setSubtitleStyle(customStyle);
    expect(service.getState().subtitleStyle).toEqual(customStyle);
    expect(engine.commands.filter((c) => c.name === 'setSubtitleStyle')).toEqual([
      { name: 'setSubtitleStyle', subtitleStyle: customStyle },
    ]);

    // Subsequent tune carries subtitleStyle in LoadOptions
    service.tune(makeRequest('movie:1'));
    await flushMicrotasks();
    flushTimers(300);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.options?.subtitleStyle).toEqual(customStyle);
    const attemptBefore = service.getState().attempt;

    // Live style update during playback does NOT restart playback or bump attempt
    const updatedStyle = {
      fontSize: 'extraLarge',
      textColor: 'cyan',
      backgroundColor: 'none',
      edgeStyle: 'outline',
      verticalPosition: 'top',
    } as const;
    service.setSubtitleStyle(updatedStyle);
    expect(service.getState().attempt).toBe(attemptBefore);
    expect(service.getState().status).toEqual({ kind: 'playing' });
    expect(loads).toHaveLength(1);
    expect(service.getState().subtitleStyle).toEqual(updatedStyle);
    expect(engine.commands.filter((c) => c.name === 'setSubtitleStyle').at(-1)).toEqual({
      name: 'setSubtitleStyle',
      subtitleStyle: updatedStyle,
    });

    // Invalid style fields are normalized to defaults via normalizeSubtitleStyle
    service.setSubtitleStyle({ fontSize: 'huge' } as unknown as SubtitleStyleConfig);
    expect(service.getState().subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE);

    // TuneRequest.subtitleStyle overrides and persists to LoadOptions
    service.tune(
      makeRequest('movie:2', 'https://stream.example.com/vod/2.m3u8', {
        subtitleStyle: customStyle,
      }),
    );
    await flushMicrotasks();
    flushTimers(300);
    expect(service.getState().subtitleStyle).toEqual(customStyle);
    expect(loads.at(-1)?.options?.subtitleStyle).toEqual(customStyle);

    // Subscriber received style notifications
    expect(seen.some((s) => s.subtitleStyle?.fontSize === 'extraLarge')).toBe(true);

    // After dispose(), setSubtitleStyle is a no-op
    const styleCountBeforeDispose = engine.commands.filter(
      (c) => c.name === 'setSubtitleStyle',
    ).length;
    service.dispose();
    service.setSubtitleStyle(updatedStyle);
    expect(engine.commands.filter((c) => c.name === 'setSubtitleStyle')).toHaveLength(
      styleCountBeforeDispose,
    );
  });

  it('enforces primary !== secondary invariant and persists secondary subtitle across recovery reloads (#402)', async () => {
    const { engine, loads, service, flushTimers } = makeHarness();

    service.tune(makeRequest('movie:dual'));
    await flushMicrotasks();
    flushTimers(300);

    // 1. Engine mistakenly reports primary === secondary -> sanitized to secondary = null
    engine.emit({
      attempt: 1,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a:1', language: 'en' }],
        subtitles: [
          { id: 's:1', language: 'en', label: 'English' },
          { id: 's:2', language: 'tr', label: 'Turkish' },
          { id: 'ext:1', language: 'de', label: 'German', external: true },
        ],
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
        selectedSecondarySubtitleId: 's:1',
      },
    });
    expect(service.getState().tracks.selectedSubtitleId).toBe('s:1');
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBeNull();

    // 2. Calling selectSecondarySubtitleTrack with active primary is a clean no-op
    service.selectSecondarySubtitleTrack('s:1');
    expect(engine.commands.filter((c) => c.name === 'selectSecondarySubtitleTrack')).toEqual([]);
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBeNull();

    // 3. Selecting a distinct secondary track succeeds
    service.selectSecondarySubtitleTrack('s:2');
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBe('s:2');
    expect(engine.commands.filter((c) => c.name === 'selectSecondarySubtitleTrack')).toEqual([
      { name: 'selectSecondarySubtitleTrack', attempt: 1, trackId: 's:2' },
    ]);

    // 4. Selecting primary equal to active secondary automatically clears secondary first!
    service.selectSubtitleTrack('s:2');
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBeNull();
    const subCmds = engine.commands.filter(
      (c) => c.name === 'selectSubtitleTrack' || c.name === 'selectSecondarySubtitleTrack',
    );
    expect(subCmds.slice(-2)).toEqual([
      { name: 'selectSecondarySubtitleTrack', attempt: 1, trackId: null },
      { name: 'selectSubtitleTrack', attempt: 1, trackId: 's:2' },
    ]);

    // 5. Now pick primary 's:1' and secondary 's:2' and verify recovery reload persistence
    service.selectSubtitleTrack('s:1');
    service.selectSecondarySubtitleTrack('s:2');
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBe('s:2');

    // Trigger VOD network recovery reload -> primary + secondary persisted in LoadOptions
    engine.emit({ attempt: 1, type: 'error', error: { code: 'network', detail: 'lost' } });
    flushTimers(2_000);

    expect(loads).toHaveLength(2);
    const recoveryLoad = loads.at(-1);
    expect(recoveryLoad?.attempt).toBe(2);
    expect(recoveryLoad?.options?.subtitleTrackId).toBe('s:1');
    expect(recoveryLoad?.options?.secondarySubtitleTrackId).toBe('s:2');

    // Reconcile shifted IDs after reload
    engine.emit({
      attempt: 2,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a:10', language: 'en' }],
        subtitles: [
          { id: 's:10', language: 'en', label: 'English' },
          { id: 's:20', language: 'tr', label: 'Turkish' },
        ],
        selectedAudioId: 'a:10',
        selectedSubtitleId: null,
        selectedSecondarySubtitleId: null,
      },
    });
    expect(engine.commands.slice(-2)).toEqual([
      { name: 'selectSubtitleTrack', attempt: 2, trackId: 's:10' },
      { name: 'selectSecondarySubtitleTrack', attempt: 2, trackId: 's:20' },
    ]);

    // 6. New tune clears secondarySubtitleTrackId so it does NOT leak into next item
    service.tune(makeRequest('movie:next', 'https://stream.example.com/vod/next.m3u8'));
    await flushMicrotasks();
    flushTimers(300);
    expect(loads.at(-1)?.options?.secondarySubtitleTrackId).toBeUndefined();
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBeUndefined();

    // 7. stop() clears secondary subtitle
    service.selectSecondarySubtitleTrack('s:99');
    service.stop();
    expect(service.getState().tracks.selectedSecondarySubtitleId).toBeUndefined();
  });

  it('bridges addExternalSubtitle, setSubtitleStyle, LoadOptions, and collision sanitization in bridgeNativeEngine', () => {
    const listeners = new Set<(event: EngineEvent) => void>();
    const handle: NativeEngineHandle = {
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      selectSecondarySubtitleTrack: vi.fn(),
      addExternalSubtitle: vi.fn(),
      setSubtitleStyle: vi.fn(),
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn((_name: 'onEngineEvent', listener: (event: EngineEvent) => void) => {
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
          },
        };
      }),
    };
    const capabilities: EngineCapabilities = {
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: true,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
      externalSubtitles: true,
      subtitleStyling: true,
      dualSubtitles: true,
    };
    const engine = bridgeNativeEngine(handle, {
      capabilities,
      uptimeMs: () => 100,
      now: () => 1_000,
    });
    const received: EngineEvent[] = [];
    engine.subscribe((e) => received.push(e));

    const ext: ExternalSubtitleTrack = {
      id: 'ext:1',
      uri: 'https://subs.example.com/sub.vtt',
      mimeType: 'text/vtt',
    };
    const style: SubtitleStyleConfig = {
      fontSize: 'large',
      textColor: 'yellow',
      backgroundColor: 'translucent',
      edgeStyle: 'outline',
      verticalPosition: 'bottom',
    };

    engine.load({
      attempt: 1,
      url: 'https://stream.example.com/live/1.m3u8',
      headers: { Authorization: 'Bearer secret' },
      kind: 'live',
      options: {
        secondarySubtitleTrackId: 's:2',
        externalSubtitles: [ext],
        subtitleStyle: style,
      },
    });
    engine.addExternalSubtitle?.(1, ext);
    engine.setSubtitleStyle?.(style);

    expect(handle.load).toHaveBeenCalledWith({
      attempt: 1,
      url: 'https://stream.example.com/live/1.m3u8',
      headers: { Authorization: 'Bearer secret' },
      kind: 'live',
      secondarySubtitleTrackId: 's:2',
      externalSubtitles: [ext],
      subtitleStyle: style,
    });
    expect(handle.addExternalSubtitle).toHaveBeenCalledWith(1, ext);
    expect(handle.setSubtitleStyle).toHaveBeenCalledWith(style);

    // Native tracks event reporting colliding primary === secondary is sanitized to null
    for (const listener of listeners) {
      listener({
        attempt: 1,
        type: 'tracks',
        tracks: {
          audio: [],
          subtitles: [{ id: 's:1', language: 'en' }],
          selectedAudioId: null,
          selectedSubtitleId: 's:1',
          selectedSecondarySubtitleId: 's:1',
        },
      });
    }
    expect(received).toEqual([
      {
        attempt: 1,
        type: 'tracks',
        tracks: {
          audio: [],
          subtitles: [{ id: 's:1', language: 'en' }],
          selectedAudioId: null,
          selectedSubtitleId: 's:1',
          selectedSecondarySubtitleId: null,
        },
      },
    ]);

    // After release(), addExternalSubtitle and setSubtitleStyle are no-ops
    engine.release();
    engine.addExternalSubtitle?.(2, ext);
    engine.setSubtitleStyle?.(DEFAULT_SUBTITLE_STYLE);
    expect(handle.addExternalSubtitle).toHaveBeenCalledTimes(1);
    expect(handle.setSubtitleStyle).toHaveBeenCalledTimes(1);
  });

  it('handles pre-load external subtitles, adoptQueuedTarget, collapsed-track reconciliation, and optional bridge omission', async () => {
    const { engine, loads, service, flushTimers } = makeHarness();

    // Deferred resolve to test calls while tuning (loaded === false)
    let resolveDeferred!: (res: {
      ok: true;
      value: { url: string; headers: Record<string, string> };
    }) => void;
    service.tune({
      item: 'movie:deferred',
      accountKey: 'acct-1',
      kind: 'vod',
      resolve: () =>
        new Promise((r) => {
          resolveDeferred = r;
        }),
    });

    expect(
      service.addExternalSubtitle({
        id: 'ext:queued',
        uri: 'https://subs.example.com/queued.vtt',
      }),
    ).toBe(true);
    service.selectSecondarySubtitleTrack('s:2');
    expect(engine.commands).toEqual([]);

    resolveDeferred({
      ok: true,
      value: { url: 'https://stream.example.com/vod/deferred.m3u8', headers: {} },
    });
    await flushMicrotasks();
    flushTimers(300);

    expect(loads[0]?.options?.externalSubtitles).toHaveLength(1);
    expect(loads[0]?.options?.secondarySubtitleTrackId).toBe('s:2');

    // Adopt queued target replaces external subtitles and preserves/overrides subtitleStyle
    const style: SubtitleStyleConfig = {
      fontSize: 'small',
      textColor: 'green',
      backgroundColor: 'opaque',
      edgeStyle: 'none',
      verticalPosition: 'top',
    };
    service.setSubtitleStyle(style);
    service.adoptQueuedTarget(
      makeRequest('ep:2', 'https://stream.example.com/vod/ep2.m3u8', {
        externalSubtitles: [{ id: 'ext:ep2', uri: 'file:///subs/ep2.srt' }],
      }),
    );
    expect(service.getState().externalSubtitles).toEqual([
      { id: 'ext:ep2', uri: 'file:///subs/ep2.srt', mimeType: 'application/x-subrip' },
    ]);
    expect(service.getState().subtitleStyle).toEqual(style);

    // Turning primary off allows selecting that track as secondary; turning secondary off reconciles after reload
    service.tune(makeRequest('movie:collapse'));
    await flushMicrotasks();
    flushTimers(300);
    const attemptA = service.getState().attempt;
    engine.emit({
      attempt: attemptA,
      type: 'tracks',
      tracks: {
        audio: [],
        subtitles: [
          { id: 's:1', language: 'en', label: 'English' },
          { id: 's:2', language: 'en', label: 'English SDH' },
        ],
        selectedAudioId: null,
        selectedSubtitleId: 's:1',
        selectedSecondarySubtitleId: null,
      },
    });
    service.selectSubtitleTrack('s:1');
    service.selectSecondarySubtitleTrack('s:2');

    // Trigger reload where only one English track remains -> secondary must NOT collide with primary
    engine.emit({ attempt: attemptA, type: 'error', error: { code: 'network', detail: 'drop' } });
    flushTimers(2_000);
    const attemptB = service.getState().attempt;
    engine.emit({
      attempt: attemptB,
      type: 'tracks',
      tracks: {
        audio: [],
        subtitles: [{ id: 's:only', language: 'en', label: 'English' }],
        selectedAudioId: null,
        selectedSubtitleId: 's:only',
        selectedSecondarySubtitleId: null,
      },
    });
    const cmdsOnB = engine.commands.filter(
      (c) => c.attempt === attemptB && c.name === 'selectSecondarySubtitleTrack',
    );
    expect(cmdsOnB).toEqual([]);

    // Explicit secondary off clears engine-selected secondary on reload
    service.selectSecondarySubtitleTrack(null);
    engine.emit({ attempt: attemptB, type: 'error', error: { code: 'network', detail: 'drop2' } });
    flushTimers(4_000);
    const attemptC = service.getState().attempt;
    engine.emit({
      attempt: attemptC,
      type: 'tracks',
      tracks: {
        audio: [],
        subtitles: [
          { id: 's:1', language: 'en' },
          { id: 's:2', language: 'tr' },
        ],
        selectedAudioId: null,
        selectedSubtitleId: 's:1',
        selectedSecondarySubtitleId: 's:2',
      },
    });
    expect(engine.commands.at(-1)).toEqual({
      name: 'selectSecondarySubtitleTrack',
      attempt: attemptC,
      trackId: null,
    });

    // Optional native bridge methods omitted when absent on handle
    const minimalHandle: NativeEngineHandle = {
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn(() => ({ remove: vi.fn() })),
    };
    const minimalEngine = bridgeNativeEngine(minimalHandle, {
      capabilities: engine.capabilities,
      uptimeMs: () => 0,
      now: () => 0,
    });
    expect(minimalEngine.addExternalSubtitle).toBeUndefined();
    expect(minimalEngine.setSubtitleStyle).toBeUndefined();

    // Defensive normalization of malformed runtime values
    expect(normalizeExternalSubtitleTrack(null as unknown as ExternalSubtitleTrack)).toBeNull();
    expect(
      normalizeExternalSubtitleTrack({
        id: 123,
        uri: 'https://a.com/x.vtt',
      } as unknown as ExternalSubtitleTrack),
    ).toBeNull();
    expect(isAllowedExternalSubtitleUri(123 as unknown as string)).toBe(false);
  });
});

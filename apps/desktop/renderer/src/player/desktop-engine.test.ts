import type { EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  isPlayerCommandMessage,
  type PlayerBridge,
  type PlayerCommandMessage,
  type PlayerEventMessage,
  type PlayerRemoteMediaActionMessage,
  type PlayerUiEvent,
  type PlayerUiMessage,
  type VideoFrameLike,
} from '../../../src/shared/player-ipc.ts';
import { createDesktopEngine } from './desktop-engine.ts';

function fakeBridge(
  reply = { engineId: 'e1', mainNowMs: 51_000 },
  onOpen?: () => void,
  opts?: { omitOnFrame?: boolean },
) {
  const eventListeners = new Set<(m: PlayerEventMessage) => void>();
  const uiListeners = new Set<(m: PlayerUiMessage) => void>();
  const remoteListeners = new Set<(m: PlayerRemoteMediaActionMessage) => void>();
  const frameListeners = new Map<string, (frame: VideoFrameLike) => void>();
  const sent: PlayerCommandMessage[] = [];
  const areas: unknown[] = [];
  const closed: string[] = [];
  const bridge: PlayerBridge = {
    open: vi.fn(async () => {
      onOpen?.();
      return reply;
    }),
    close: vi.fn(async (id: string) => void closed.push(id)),
    send: (m) => void sent.push(m),
    setArea: (m) => void areas.push(m),
    onEvent: (l) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
    onUi: (l) => {
      uiListeners.add(l);
      return () => uiListeners.delete(l);
    },
    onRemoteMediaAction: (l) => {
      remoteListeners.add(l);
      return () => remoteListeners.delete(l);
    },
    ...(opts?.omitOnFrame
      ? {}
      : {
          onFrame: vi.fn((engineId: string, l: (frame: VideoFrameLike) => void) => {
            frameListeners.set(engineId, l);
            return () => {
              if (frameListeners.get(engineId) === l) frameListeners.delete(engineId);
            };
          }),
        }),
    reportGate: () => undefined,
  };
  return {
    bridge,
    sent,
    areas,
    closed,
    eventListeners,
    uiListeners,
    remoteListeners,
    frameListeners,
    event: (engineId: string, event: EngineEvent) => {
      for (const l of [...eventListeners]) l({ engineId, event });
    },
    ui: (engineId: string, ui: PlayerUiEvent) => {
      for (const l of [...uiListeners]) l({ engineId, ui });
    },
    remoteAction: (engineId: string, action: 'next' | 'previous') => {
      for (const l of [...remoteListeners]) l({ engineId, action });
    },
    frame: (engineId: string, frame: VideoFrameLike) => {
      frameListeners.get(engineId)?.(frame);
    },
  };
}

/** A renderer clock that advances 40 ms across `open` (t0 = 1000, t1 = 1040). */
function steppedClock() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createDesktopEngine', () => {
  it('maps atMs with the handshake offset', async () => {
    const clock = steppedClock();
    const f = fakeBridge(undefined, () => clock.advance(40));
    const engine = await createDesktopEngine(f.bridge, clock.now);
    // offset = (1000 + 1040) / 2 - 51000 = -49980
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    f.event('e1', { attempt: 1, type: 'firstFrame', atMs: 51_100 });
    f.event('e1', {
      attempt: 1,
      type: 'clock',
      anchor: { positionMs: 5, atMs: 52_000, rate: 1, durationMs: 9, liveEdgeMs: 7 },
    });
    f.event('e1', { attempt: 1, type: 'stall', phase: 'start', atMs: 53_000 });
    f.event('e1', { attempt: 1, type: 'state', state: 'playing' });
    f.event('e1', { attempt: 1, type: 'error', error: { code: 'network' } });
    f.event('e1', { attempt: 1, type: 'surface', change: 'created' });
    expect(events).toEqual([
      { attempt: 1, type: 'firstFrame', atMs: 1120 },
      {
        attempt: 1,
        type: 'clock',
        anchor: { positionMs: 5, atMs: 2020, rate: 1, durationMs: 9, liveEdgeMs: 7 },
      },
      { attempt: 1, type: 'stall', phase: 'start', atMs: 3020 },
      { attempt: 1, type: 'state', state: 'playing' },
      { attempt: 1, type: 'error', error: { code: 'network' } },
      { attempt: 1, type: 'surface', change: 'created' },
    ]);
  });

  it('capabilities are DESKTOP_CAPABILITIES', async () => {
    const engine = await createDesktopEngine(fakeBridge().bridge, () => 0);
    expect(engine.capabilities).toEqual(DESKTOP_CAPABILITIES);
    expect(engine.engineId).toBe('e1');
  });

  it('sends every port command tagged with the engine id', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    const cmd = { attempt: 1, url: 'http://x/a.ts', headers: { a: 'b' }, kind: 'live' as const };
    engine.load(cmd);
    engine.retry(2);
    engine.play(2);
    engine.pause(2);
    engine.seek(3, 900);
    engine.setSpeed(3, 1.5);
    engine.selectAudioTrack?.(3, 'a:2');
    engine.selectSubtitleTrack?.(3, 's:1');
    engine.selectSubtitleTrack?.(3, null);
    engine.setVolume(75);
    engine.setAudioDelay(0.25);
    engine.setSubtitleDelay(-0.5);
    engine.setAudioDevice('wasapi/{out-1}');
    engine.setDeinterlace(true);
    engine.setDeinterlace(false);
    engine.setHwdec('auto-safe');
    engine.setHwdec('auto-copy');
    engine.setHwdec('no');
    engine.setHwdec('darwin-compat');
    engine.stop(4);
    engine.recreate(5);
    engine.toggleFullscreen();
    engine.toggleMute();
    expect(f.sent).toEqual([
      { engineId: 'e1', command: { name: 'load', cmd } },
      { engineId: 'e1', command: { name: 'retry', attempt: 2 } },
      { engineId: 'e1', command: { name: 'play', attempt: 2 } },
      { engineId: 'e1', command: { name: 'pause', attempt: 2 } },
      { engineId: 'e1', command: { name: 'seek', attempt: 3, positionMs: 900 } },
      { engineId: 'e1', command: { name: 'setSpeed', attempt: 3, rate: 1.5 } },
      { engineId: 'e1', command: { name: 'selectAudioTrack', attempt: 3, id: 'a:2' } },
      { engineId: 'e1', command: { name: 'selectSubtitleTrack', attempt: 3, id: 's:1' } },
      { engineId: 'e1', command: { name: 'selectSubtitleTrack', attempt: 3, id: null } },
      { engineId: 'e1', command: { name: 'setVolume', volume: 75 } },
      { engineId: 'e1', command: { name: 'setAudioDelay', delaySec: 0.25 } },
      { engineId: 'e1', command: { name: 'setSubtitleDelay', delaySec: -0.5 } },
      { engineId: 'e1', command: { name: 'setAudioDevice', device: 'wasapi/{out-1}' } },
      { engineId: 'e1', command: { name: 'setDeinterlace', enabled: true } },
      { engineId: 'e1', command: { name: 'setDeinterlace', enabled: false } },
      { engineId: 'e1', command: { name: 'setHwdec', profile: 'auto-safe' } },
      { engineId: 'e1', command: { name: 'setHwdec', profile: 'auto-copy' } },
      { engineId: 'e1', command: { name: 'setHwdec', profile: 'no' } },
      { engineId: 'e1', command: { name: 'setHwdec', profile: 'darwin-compat' } },
      { engineId: 'e1', command: { name: 'stop', attempt: 4 } },
      { engineId: 'e1', command: { name: 'recreate', attempt: 5 } },
      { engineId: 'e1', command: { name: 'fullscreen' } },
      { engineId: 'e1', command: { name: 'mute' } },
    ]);
    for (const msg of f.sent) {
      expect(isPlayerCommandMessage(msg)).toBe(true);
    }
  });

  it('sends the player area', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    const area = { x: 0, y: 40, width: 800, height: 450, visible: true };
    engine.setArea(area);
    expect(f.areas).toEqual([{ engineId: 'e1', area }]);
  });

  it('ignores events and ui of other engines', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    const events: EngineEvent[] = [];
    const ui: PlayerUiEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.onUi((e) => ui.push(e));
    f.event('other', { attempt: 1, type: 'state', state: 'playing' });
    f.ui('other', { type: 'closed' });
    f.ui('e1', { type: 'key', key: 'back' });
    expect(events).toEqual([]);
    expect(ui).toEqual([{ type: 'key', key: 'back' }]);
  });

  it('delivers events that beat the open reply to the first subscriber, mapped, and drops other engines', async () => {
    const f = fakeBridge(undefined, () => {
      f.ui('e1', { type: 'presenter', kind: 'child-window', coversArea: true });
      f.ui('zz', { type: 'closed' });
      f.event('e1', { attempt: 0, type: 'surface', change: 'created' });
      f.event('zz', { attempt: 0, type: 'surface', change: 'destroyed' });
      f.event('e1', { attempt: 0, type: 'firstFrame', atMs: 51_000 });
    });
    const engine = await createDesktopEngine(f.bridge, () => 1000);
    const first: EngineEvent[] = [];
    const second: EngineEvent[] = [];
    const ui: PlayerUiEvent[] = [];
    engine.subscribe((e) => first.push(e));
    engine.subscribe((e) => second.push(e));
    engine.onUi((e) => ui.push(e));
    expect(ui).toEqual([{ type: 'presenter', kind: 'child-window', coversArea: true }]);
    expect(first).toEqual([
      { attempt: 0, type: 'surface', change: 'created' },
      { attempt: 0, type: 'firstFrame', atMs: 1000 },
    ]);
    expect(second).toEqual([]);
  });

  it('delivers an event that arrives after the reply but before any subscriber to the first one', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    f.event('e1', { attempt: 0, type: 'surface', change: 'created' });
    const seen: EngineEvent[] = [];
    engine.subscribe((e) => seen.push(e));
    f.event('e1', { attempt: 0, type: 'state', state: 'opening' });
    expect(seen.map((e) => e.type)).toEqual(['surface', 'state']);
  });

  it('a throwing ui listener does not break the presenter replay', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    f.ui('e1', { type: 'presenter', kind: 'child-window', coversArea: true });
    expect(() =>
      engine.onUi(() => {
        throw new Error('ui bug');
      }),
    ).not.toThrow();
  });

  it('replays the presenter state to a later ui listener', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    f.ui('e1', { type: 'presenter', kind: 'own-window', coversArea: false });
    f.ui('e1', { type: 'key', key: 'close' });
    const late: PlayerUiEvent[] = [];
    engine.onUi((e) => late.push(e));
    expect(late).toEqual([{ type: 'presenter', kind: 'own-window', coversArea: false }]);
  });

  it('unsubscribe stops delivery and a throwing listener does not stop the others', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    const seen: EngineEvent[] = [];
    engine.subscribe(() => {
      throw new Error('listener bug');
    });
    const off = engine.subscribe((e) => seen.push(e));
    const offUi = engine.onUi(() => {
      throw new Error('ui bug');
    });
    f.event('e1', { attempt: 1, type: 'state', state: 'opening' });
    f.ui('e1', { type: 'closed' });
    off();
    offUi();
    f.event('e1', { attempt: 1, type: 'state', state: 'playing' });
    expect(seen).toHaveLength(1);
  });

  it('release sends release, closes the engine and stops listening', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.release();
    engine.release();
    expect(f.sent).toEqual([{ engineId: 'e1', command: { name: 'release' } }]);
    expect(f.closed).toEqual(['e1']);
    expect(f.eventListeners.size).toBe(0);
    expect(f.uiListeners.size).toBe(0);
    engine.load({ attempt: 1, url: 'http://x/a.ts', headers: {}, kind: 'live' });
    engine.stop(2);
    engine.setArea({ x: 0, y: 0, width: 1, height: 1, visible: false });
    engine.toggleFullscreen();
    engine.setSpeed(2, 1.5);
    engine.setVolume(50);
    engine.setAudioDelay(0.1);
    engine.setSubtitleDelay(0.1);
    engine.setAudioDevice('auto');
    engine.setDeinterlace(true);
    engine.setHwdec('no');
    expect(f.sent).toHaveLength(1);
    expect(f.areas).toEqual([]);
    const late = engine.subscribe(() => undefined);
    late();
    expect(engine.onUi(() => undefined)).toBeTypeOf('function');
    expect(events).toEqual([]);
  });

  it('release survives a failing close', async () => {
    const f = fakeBridge();
    vi.mocked(f.bridge.close).mockRejectedValueOnce(new Error('gone'));
    const engine = await createDesktopEngine(f.bridge, () => 0);
    expect(() => engine.release()).not.toThrow();
    await Promise.resolve();
  });

  it('open failure rejects and leaves no listeners behind', async () => {
    const f = fakeBridge();
    vi.mocked(f.bridge.open).mockRejectedValueOnce(
      new Error('mpv runtime missing; run pnpm mpv fetch'),
    );
    await expect(createDesktopEngine(f.bridge, () => 0)).rejects.toThrow('mpv runtime missing');
    expect(f.eventListeners.size).toBe(0);
    expect(f.uiListeners.size).toBe(0);
  });

  it('caps earlyEvents and earlyUi to 100 entries while preserving presenter ui event', async () => {
    const f = fakeBridge(undefined, () => {
      for (let i = 0; i < 150; i += 1) {
        f.event('e1', { attempt: i, type: 'state', state: 'opening' });
        f.ui('e1', { type: 'key', key: 'back' });
      }
      f.ui('e1', { type: 'presenter', kind: 'child-window', coversArea: true });
    });
    const engine = await createDesktopEngine(f.bridge, () => 0);
    const seenEvents: EngineEvent[] = [];
    const seenUi: PlayerUiEvent[] = [];
    engine.subscribe((e) => seenEvents.push(e));
    engine.onUi((e) => seenUi.push(e));
    expect(seenEvents).toHaveLength(100);
    expect(seenUi).toEqual([{ type: 'presenter', kind: 'child-window', coversArea: true }]);
  });

  it('delegates onFrame with engineId, cleans up on unsubscribe and release, and handles missing bridge.onFrame', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);

    const received: VideoFrameLike[] = [];
    const off = engine.onFrame?.((frame) => received.push(frame));
    expect(f.frameListeners.size).toBe(1);

    const frame1: VideoFrameLike = { codedWidth: 1280, codedHeight: 720, close: vi.fn() };
    f.frame('e1', frame1);
    expect(received).toEqual([frame1]);

    // Explicit unsubscribe is idempotent and removes the listener.
    off?.();
    off?.();
    expect(f.frameListeners.size).toBe(0);

    // Active frame listener is cleaned up automatically on release().
    const afterRebind = vi.fn();
    engine.onFrame?.(afterRebind);
    expect(f.frameListeners.size).toBe(1);
    engine.release();
    expect(f.frameListeners.size).toBe(0);

    // Subscribing after release is a no-op.
    const lateOff = engine.onFrame?.(vi.fn());
    expect(f.frameListeners.size).toBe(0);
    expect(() => lateOff?.()).not.toThrow();

    // Bridge without onFrame returns a safe no-op unsubscribe.
    const legacy = fakeBridge(undefined, undefined, { omitOnFrame: true });
    const legacyEngine = await createDesktopEngine(legacy.bridge, () => 0);
    const noop = legacyEngine.onFrame?.(vi.fn());
    expect(noop).toBeTypeOf('function');
    expect(() => noop?.()).not.toThrow();
    legacyEngine.release();
  });

  it('forwards mediaInfo events untouched and tracks fullscreen-changed UI state (#58, #394)', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 1000);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    const mediaInfo: EngineEvent = {
      attempt: 2,
      type: 'mediaInfo',
      info: { width: 3840, height: 2160, fps: 60, codec: 'hevc', hdr: 'hdr10' },
    };
    f.event('e1', mediaInfo);
    expect(events).toEqual([mediaInfo]);

    expect(engine.isFullscreen()).toBe(false);
    const seenUi: PlayerUiEvent[] = [];
    engine.onUi((e) => seenUi.push(e));
    f.ui('e1', { type: 'fullscreen-changed', fullscreen: true });
    expect(engine.isFullscreen()).toBe(true);
    expect(seenUi).toEqual([{ type: 'fullscreen-changed', fullscreen: true }]);

    // Late UI subscriber receives the latest fullscreen-changed state
    const lateUi: PlayerUiEvent[] = [];
    engine.onUi((e) => lateUi.push(e));
    expect(lateUi).toEqual([{ type: 'fullscreen-changed', fullscreen: true }]);

    f.ui('e1', { type: 'fullscreen-changed', fullscreen: false });
    expect(engine.isFullscreen()).toBe(false);

    // Forwards setResizeMode, setFilterSdh, setSubtitleFontFamily, chapters, and telemetry events (#118, #124, #160, #163, #310)
    engine.setResizeMode('fill');
    engine.setFilterSdh(true);
    engine.setSubtitleFontFamily('atkinson');
    engine.setSubtitleFontFamily('opendyslexic');
    engine.setSubtitleFontFamily('system');
    expect(f.sent).toContainEqual({
      engineId: 'e1',
      command: { name: 'setResizeMode', mode: 'fill' },
    });
    expect(f.sent).toContainEqual({
      engineId: 'e1',
      command: { name: 'setFilterSdh', enabled: true },
    });
    expect(f.sent).toContainEqual({
      engineId: 'e1',
      command: { name: 'setSubtitleFontFamily', family: 'atkinson' },
    });
    expect(f.sent).toContainEqual({
      engineId: 'e1',
      command: { name: 'setSubtitleFontFamily', family: 'opendyslexic' },
    });
    expect(f.sent).toContainEqual({
      engineId: 'e1',
      command: { name: 'setSubtitleFontFamily', family: 'system' },
    });
    const chaptersEvent: EngineEvent = {
      attempt: 2,
      type: 'chapters',
      chapters: [{ id: 'ch:0', title: 'Intro', startMs: 0, endMs: 60_000 }],
    };
    const telemetryEvent: EngineEvent = { attempt: 2, type: 'telemetry', droppedFrames: 5 };
    f.event('e1', chaptersEvent);
    f.event('e1', telemetryEvent);
    expect(events).toContainEqual(chaptersEvent);
    expect(events).toContainEqual(telemetryEvent);
  });

  it('tracks audio-devices UI updates, replays to late subscribers, and cleans up on release (#408)', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);
    expect(engine.getAudioDevices()).toEqual([]);
    expect(engine.getActiveAudioDevice()).toBe('auto');

    const seen: Array<{ devices: unknown; active: string }> = [];
    const off = engine.onAudioDevicesChange((devices, active) => seen.push({ devices, active }));

    const devices = [
      { name: 'auto', description: 'Autoselect device' },
      { name: 'wasapi/{1}', description: 'Headphones' },
    ];
    f.ui('e1', { type: 'audio-devices', devices, active: 'wasapi/{1}' });
    expect(engine.getAudioDevices()).toEqual(devices);
    expect(engine.getActiveAudioDevice()).toBe('wasapi/{1}');
    expect(seen).toEqual([{ devices, active: 'wasapi/{1}' }]);

    const late: Array<{ devices: unknown; active: string }> = [];
    engine.onAudioDevicesChange((d, a) => late.push({ devices: d, active: a }));
    expect(late).toEqual([{ devices, active: 'wasapi/{1}' }]);

    off();
    f.ui('e1', { type: 'audio-devices', devices, active: 'auto' });
    expect(seen).toHaveLength(1);
    expect(late).toHaveLength(2);

    engine.release();
    expect(engine.onAudioDevicesChange(() => undefined)).toBeTypeOf('function');
  });

  it('forwards setMediaMetadata and delivers filtered onRemoteMediaAction events (#238, #301)', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);

    const meta = {
      title: 'Channel One',
      subtitle: 'News',
      artworkUrl: 'https://cdn.example.test/logo.png',
      kind: 'live' as const,
      canStepTrack: true,
    };
    engine.setMediaMetadata(meta);
    engine.setMediaMetadata(null);
    expect(f.sent).toEqual([
      { engineId: 'e1', command: { name: 'setMediaMetadata', metadata: meta } },
      { engineId: 'e1', command: { name: 'setMediaMetadata', metadata: null } },
    ]);
    for (const msg of f.sent) expect(isPlayerCommandMessage(msg)).toBe(true);

    const actions: string[] = [];
    const off = engine.onRemoteMediaAction((a) => actions.push(a));
    f.remoteAction('other', 'next');
    f.remoteAction('e1', 'next');
    f.remoteAction('e1', 'previous');
    expect(actions).toEqual(['next', 'previous']);

    off();
    f.remoteAction('e1', 'next');
    expect(actions).toEqual(['next', 'previous']);

    engine.release();
    expect(f.remoteListeners.size).toBe(0);
    expect(engine.onRemoteMediaAction(() => undefined)).toBeTypeOf('function');
  });

  it('bridges PlayerEngine ms delays, secondary subtitle, and video quality over IPC (#59, #239)', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 0);

    expect(engine.capabilities.audioDelay).toBe(true);
    expect(engine.capabilities.subtitleDelay).toBe(true);
    expect(engine.capabilities.videoQualitySelection).toBe(true);
    expect(engine.capabilities.externalSubtitles).toBe(true);
    expect(engine.capabilities.subtitleStyling).toBe(true);
    expect(engine.capabilities.dualSubtitles).toBe(true);

    engine.setAudioDelay(4, 250);
    engine.setAudioDelay(5, 99_000);
    engine.setSubtitleDelay(6, -500);
    engine.setSubtitleDelay(7, Number.NaN);
    engine.selectSecondarySubtitleTrack?.(8, 's:2');
    engine.selectSecondarySubtitleTrack?.(9, null);
    engine.selectVideoQuality?.(10, '2');
    engine.selectVideoQuality?.(11, null);
    const extTrack = {
      id: 'ext-1',
      uri: 'https://subs.example.test/en.srt',
      label: 'English',
      language: 'en',
    };
    const subStyle = {
      fontSize: 'large' as const,
      textColor: 'yellow' as const,
      backgroundColor: 'opaque' as const,
      edgeStyle: 'dropShadow' as const,
      verticalPosition: 'raised' as const,
    };
    engine.addExternalSubtitle?.(12, extTrack);
    engine.setSubtitleStyle?.(subStyle);

    expect(f.sent).toEqual([
      { engineId: 'e1', command: { name: 'setAudioDelay', attempt: 4, delaySec: 0.25 } },
      { engineId: 'e1', command: { name: 'setAudioDelay', attempt: 5, delaySec: 30 } },
      { engineId: 'e1', command: { name: 'setSubtitleDelay', attempt: 6, delaySec: -0.5 } },
      { engineId: 'e1', command: { name: 'selectSecondarySubtitleTrack', attempt: 8, id: 's:2' } },
      { engineId: 'e1', command: { name: 'selectSecondarySubtitleTrack', attempt: 9, id: null } },
      { engineId: 'e1', command: { name: 'selectVideoQuality', attempt: 10, id: '2' } },
      { engineId: 'e1', command: { name: 'selectVideoQuality', attempt: 11, id: null } },
      { engineId: 'e1', command: { name: 'addExternalSubtitle', attempt: 12, track: extTrack } },
      { engineId: 'e1', command: { name: 'setSubtitleStyle', style: subStyle } },
    ]);
    for (const msg of f.sent) expect(isPlayerCommandMessage(msg)).toBe(true);
  });

  it('forwards Multi-View open options, setMuted, and setPrimary (#34)', async () => {
    const f = fakeBridge();
    const setPrimary = vi.fn(async (_id: string) => undefined);
    f.bridge.setPrimary = setPrimary;

    const engine = await createDesktopEngine(f.bridge, () => 0, {
      replaceExisting: false,
      primary: false,
    });
    expect(f.bridge.open).toHaveBeenCalledWith({ replaceExisting: false, primary: false });

    engine.setMuted(true);
    engine.setMuted(false);
    engine.setPrimary();
    expect(f.sent).toEqual([
      { engineId: 'e1', command: { name: 'setMuted', muted: true } },
      { engineId: 'e1', command: { name: 'setMuted', muted: false } },
    ]);
    expect(setPrimary).toHaveBeenCalledWith('e1');

    engine.release();
    engine.setPrimary();
    expect(setPrimary).toHaveBeenCalledTimes(1);
  });

  it('forwards options.bufferPreset on load and preserves clock anchor bufferHealth (#350)', async () => {
    const clock = steppedClock();
    const f = fakeBridge(undefined, () => clock.advance(40));
    const engine = await createDesktopEngine(f.bridge, clock.now);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.load({
      attempt: 1,
      url: 'http://sim.test/movie/demo/demo/1.mp4',
      headers: {},
      kind: 'vod',
      options: { bufferPreset: 'large' },
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toEqual({
      engineId: 'e1',
      command: {
        name: 'load',
        cmd: {
          attempt: 1,
          url: 'http://sim.test/movie/demo/demo/1.mp4',
          headers: {},
          kind: 'vod',
          options: { bufferPreset: 'large' },
        },
      },
    });
    expect(isPlayerCommandMessage(f.sent[0])).toBe(true);

    f.event('e1', {
      attempt: 1,
      type: 'clock',
      anchor: {
        positionMs: 15_000,
        atMs: 52_000,
        rate: 1,
        durationMs: 600_000,
        bufferHealth: { bufferedAheadMs: 45_000, bufferedBehindMs: 12_000 },
      },
    });
    expect(events[0]).toEqual({
      attempt: 1,
      type: 'clock',
      anchor: {
        positionMs: 15_000,
        atMs: 2020,
        rate: 1,
        durationMs: 600_000,
        bufferHealth: { bufferedAheadMs: 45_000, bufferedBehindMs: 12_000 },
      },
    });
  });
});

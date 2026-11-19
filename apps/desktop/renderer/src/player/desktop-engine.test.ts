import type { EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  type PlayerBridge,
  type PlayerCommandMessage,
  type PlayerEventMessage,
  type PlayerUiEvent,
  type PlayerUiMessage,
} from '../../../src/shared/player-ipc.ts';
import { createDesktopEngine } from './desktop-engine.ts';

function fakeBridge(reply = { engineId: 'e1', mainNowMs: 51_000 }, onOpen?: () => void) {
  const eventListeners = new Set<(m: PlayerEventMessage) => void>();
  const uiListeners = new Set<(m: PlayerUiMessage) => void>();
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
    reportGate: () => undefined,
  };
  return {
    bridge,
    sent,
    areas,
    closed,
    eventListeners,
    uiListeners,
    event: (engineId: string, event: EngineEvent) => {
      for (const l of [...eventListeners]) l({ engineId, event });
    },
    ui: (engineId: string, ui: PlayerUiEvent) => {
      for (const l of [...uiListeners]) l({ engineId, ui });
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
    engine.selectAudioTrack?.(3, 'a:2');
    engine.selectSubtitleTrack?.(3, 's:1');
    engine.selectSubtitleTrack?.(3, null);
    engine.stop(4);
    engine.recreate(5);
    engine.toggleFullscreen();
    expect(f.sent).toEqual([
      { engineId: 'e1', command: { name: 'load', cmd } },
      { engineId: 'e1', command: { name: 'retry', attempt: 2 } },
      { engineId: 'e1', command: { name: 'play', attempt: 2 } },
      { engineId: 'e1', command: { name: 'pause', attempt: 2 } },
      { engineId: 'e1', command: { name: 'seek', attempt: 3, positionMs: 900 } },
      { engineId: 'e1', command: { name: 'selectAudioTrack', attempt: 3, id: 'a:2' } },
      { engineId: 'e1', command: { name: 'selectSubtitleTrack', attempt: 3, id: 's:1' } },
      { engineId: 'e1', command: { name: 'selectSubtitleTrack', attempt: 3, id: null } },
      { engineId: 'e1', command: { name: 'stop', attempt: 4 } },
      { engineId: 'e1', command: { name: 'recreate', attempt: 5 } },
      { engineId: 'e1', command: { name: 'fullscreen' } },
    ]);
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
});

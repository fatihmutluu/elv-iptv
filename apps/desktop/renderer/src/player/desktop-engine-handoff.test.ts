import type { EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import type {
  PlayerBridge,
  PlayerCommandMessage,
  PlayerEventMessage,
  PlayerUiMessage,
} from '../../../src/shared/player-ipc.ts';
import { adoptDesktopEngine, createDesktopEngine } from './desktop-engine.ts';

function fakeBridge() {
  const eventListeners = new Set<(m: PlayerEventMessage) => void>();
  const uiListeners = new Set<(m: PlayerUiMessage) => void>();
  const sent: PlayerCommandMessage[] = [];
  const closed: string[] = [];
  const emitEvent = (engineId: string, event: EngineEvent) => {
    for (const l of [...eventListeners]) l({ engineId, event });
  };
  const emitUi = (engineId: string, ui: PlayerUiMessage['ui']) => {
    for (const l of [...uiListeners]) l({ engineId, ui });
  };
  const open = vi.fn(async () => ({ engineId: 'engine-1', mainNowMs: 100 }));
  const close = vi.fn(async (id: string) => {
    closed.push(id);
  });
  const park = vi.fn(async () => true);
  const adopt = vi.fn(async (id: string) => {
    emitUi(id, { type: 'presenter', kind: 'canvas', coversArea: false });
    emitUi(id, { type: 'fullscreen-changed', fullscreen: true });
    emitEvent(id, { attempt: 4, type: 'state', state: 'playing' });
    emitEvent(id, {
      attempt: 4,
      type: 'clock',
      anchor: { positionMs: 5000, atMs: 1000, rate: 1 },
    });
    return { engineId: id, mainNowMs: 1000 };
  });
  const bridge: PlayerBridge = {
    open,
    close,
    park,
    adopt,
    send: (m) => void sent.push(m),
    setArea: () => undefined,
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
  return { bridge, sent, closed, eventListeners, uiListeners, open, close, park, adopt };
}

describe('desktop-engine park/detach & adopt (Wave P3)', () => {
  it('detach unsubscribes local listeners WITHOUT sending release or calling bridge.close', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 200);
    const seen: EngineEvent[] = [];
    engine.subscribe((e) => seen.push(e));
    expect(f.eventListeners.size).toBe(1);
    expect(f.uiListeners.size).toBe(1);

    engine.detach();
    expect(f.eventListeners.size).toBe(0);
    expect(f.uiListeners.size).toBe(0);
    expect(f.sent).toEqual([]);
    expect(f.closed).toEqual([]);

    // Subsequent release() after detach() must remain a no-op
    engine.release();
    expect(f.sent).toEqual([]);
    expect(f.closed).toEqual([]);
  });

  it('adoptDesktopEngine captures early replayed UI/engine events, shifts clock, and returns null when adopt fails', async () => {
    const f = fakeBridge();
    let nowMs = 2000;
    const engine = await adoptDesktopEngine(f.bridge, 'engine-7', () => {
      nowMs += 20;
      return nowMs;
    });
    expect(engine).not.toBeNull();
    expect(engine?.engineId).toBe('engine-7');
    expect(engine?.isFullscreen()).toBe(true);

    const ui: PlayerUiMessage['ui'][] = [];
    engine?.onUi((ev) => ui.push(ev));
    expect(ui).toEqual([
      { type: 'presenter', kind: 'canvas', coversArea: false },
      { type: 'fullscreen-changed', fullscreen: true },
    ]);

    const events: EngineEvent[] = [];
    engine?.subscribe((ev) => events.push(ev));
    expect(events).toEqual([
      { attempt: 4, type: 'state', state: 'playing' },
      {
        attempt: 4,
        type: 'clock',
        anchor: { positionMs: 5000, atMs: 2030, rate: 1 },
      },
    ]);

    engine?.release();
    expect(f.closed).toEqual(['engine-7']);

    // Null reply cleans up listeners and returns null
    f.adopt.mockResolvedValueOnce(null as never);
    await expect(adoptDesktopEngine(f.bridge, 'missing', () => 0)).resolves.toBeNull();
    expect(f.eventListeners.size).toBe(0);
    expect(f.uiListeners.size).toBe(0);
  });
});

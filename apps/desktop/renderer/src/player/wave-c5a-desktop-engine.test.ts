import { describe, expect, it } from 'vitest';
import type {
  PlayerBridge,
  PlayerCommandMessage,
  PlayerEventMessage,
  PlayerUiMessage,
} from '../../../src/shared/player-ipc.ts';
import { createDesktopEngine } from './desktop-engine.ts';

function fakeBridge() {
  const sent: PlayerCommandMessage[] = [];
  const uiListeners = new Set<(message: PlayerUiMessage) => void>();
  const eventListeners = new Set<(message: PlayerEventMessage) => void>();

  const bridge: PlayerBridge = {
    open: async () => ({ engineId: 'engine-9', mainNowMs: 100 }),
    close: async () => undefined,
    send: (msg) => void sent.push(msg),
    setArea: () => undefined,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onUi(listener) {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    reportGate: () => undefined,
  };

  return {
    bridge,
    sent,
    emitUi: (message: PlayerUiMessage) => {
      for (const l of [...uiListeners]) l(message);
    },
  };
}

describe('DesktopEngine Wave C5A controls & queueAdvanced (#243, #205)', () => {
  it('forwards setDeinterlaceMode, setPitchLock, setAudioNormalization, queueNext, clearQueue and delivers onQueueAdvanced', async () => {
    const f = fakeBridge();
    const engine = await createDesktopEngine(f.bridge, () => 200);

    const advanced: string[] = [];
    const off = engine.onQueueAdvanced((itemKey) => advanced.push(itemKey));

    engine.setDeinterlaceMode('bwdif');
    engine.setPitchLock(false);
    engine.setPitchLock(1, true);
    engine.setAudioNormalization(true);
    const req = {
      itemKey: 'series:s1:ep2',
      stream: { url: 'https://sim.test/ep2.mkv', headers: { 'User-Agent': 'ELV' } },
      preferHevcOverDolbyVision: false,
      filterSdhSubtitles: true,
    };
    engine.queueNext(req);
    engine.clearQueue();

    expect(f.sent).toEqual([
      { engineId: 'engine-9', command: { name: 'setDeinterlaceMode', mode: 'bwdif' } },
      { engineId: 'engine-9', command: { name: 'setPitchLock', locked: false } },
      { engineId: 'engine-9', command: { name: 'setPitchLock', locked: true } },
      { engineId: 'engine-9', command: { name: 'setAudioNormalization', enabled: true } },
      { engineId: 'engine-9', command: { name: 'queueNext', request: req } },
      { engineId: 'engine-9', command: { name: 'clearQueue' } },
    ]);

    f.emitUi({
      engineId: 'engine-other',
      ui: { type: 'queueAdvanced', itemKey: 'wrong-engine' },
    });
    f.emitUi({
      engineId: 'engine-9',
      ui: { type: 'queueAdvanced', itemKey: 'series:s1:ep2', attempt: 1 },
    });
    expect(advanced).toEqual(['series:s1:ep2']);

    off();
    f.emitUi({
      engineId: 'engine-9',
      ui: { type: 'queueAdvanced', itemKey: 'series:s1:ep3', attempt: 1 },
    });
    expect(advanced).toEqual(['series:s1:ep2']);

    engine.release();
  });
});

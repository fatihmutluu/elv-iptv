import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  type PlayerBridge,
  type PlayerCommandMessage,
} from '../../../src/shared/player-ipc.ts';
import { createDesktopEngine } from './desktop-engine.ts';

function fakeBridge() {
  const sent: PlayerCommandMessage[] = [];
  const bridge: PlayerBridge = {
    open: vi.fn(async () => ({ engineId: 'engine-f7b', mainNowMs: 100 })),
    close: vi.fn(async () => undefined),
    setPrimary: vi.fn(async () => undefined),
    send: (m) => void sent.push(m),
    setArea: () => undefined,
    onEvent: () => () => undefined,
    onUi: () => () => undefined,
    onRemoteMediaAction: () => () => undefined,
    reportGate: () => undefined,
  };
  return { bridge, sent };
}

describe('Wave F7B DesktopEngine multi-program selection (#304)', () => {
  it('exposes programSelection capability matching DESKTOP_CAPABILITIES and forwards selectProgram over IPC', async () => {
    const fake = fakeBridge();
    const engine = await createDesktopEngine(fake.bridge, () => 100);

    expect(engine.capabilities.programSelection).toBe(true);
    expect(engine.capabilities).toEqual(DESKTOP_CAPABILITIES);

    engine.selectProgram?.(7, '202');
    expect(fake.sent).toEqual([
      { engineId: 'engine-f7b', command: { name: 'selectProgram', attempt: 7, id: '202' } },
    ]);

    engine.release();
  });
});

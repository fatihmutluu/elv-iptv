import { describe, expect, it, vi } from 'vitest';
import { PLAYER_CHANNELS } from '../../shared/player-ipc.ts';
import type { TrustedSenderEventLike } from '../trusted-sender.ts';
import type { MpvEngine } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';

type Listener = (
  event: TrustedSenderEventLike & { sender: WebContentsLike },
  ...args: unknown[]
) => unknown;

function makeTopFrame(url = 'app://elv/index.html') {
  const frame: { url: string; top?: unknown } = { url };
  frame.top = frame;
  return frame;
}

function makeSender(id = 1): WebContentsLike {
  return {
    id,
    isDestroyed: () => false,
    send: () => undefined,
    once: () => undefined,
    on: () => undefined,
  };
}

describe('registerPlayerIpc senderFrame enforcement', () => {
  it('rejects invoke channels and drops/logs send channels from missing, subframe, or untrusted senders', async () => {
    const handlers = new Map<string, Listener>();
    const listeners = new Map<string, Listener>();
    const ipcMain: IpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn),
      on: (ch, fn) => void listeners.set(ch, fn),
      removeHandler: (ch) => void handlers.delete(ch),
      removeListener: (ch) => void listeners.delete(ch),
    };

    const createEngine = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const gateReport = vi.fn();
    const logs: string[] = [];

    const dispose = registerPlayerIpc({
      ipcMain,
      createEngine: createEngine as unknown as (
        owner: WebContentsLike,
        onUi: never,
        engineId: string,
      ) => Promise<MpvEngine>,
      now: () => 100,
      log: (line) => logs.push(line),
      gateReport,
    });

    const sender = makeSender(1);
    const top = makeTopFrame();
    const badEvents: Array<TrustedSenderEventLike & { sender: WebContentsLike }> = [
      { sender },
      { sender, senderFrame: null },
      { sender, senderFrame: { url: 'app://elv/index.html', top } },
      { sender, senderFrame: makeTopFrame('https://evil.example/') },
    ];

    const handleChannels = [
      PLAYER_CHANNELS.open,
      PLAYER_CHANNELS.close,
      PLAYER_CHANNELS.park,
      PLAYER_CHANNELS.adopt,
      PLAYER_CHANNELS.setPrimary,
      PLAYER_CHANNELS.setScrubbing,
      PLAYER_CHANNELS.pickSubtitleFile,
    ];
    for (const ch of handleChannels) {
      const fn = handlers.get(ch);
      expect(fn).toBeDefined();
      for (const ev of badEvents) {
        await expect(Promise.resolve(fn?.(ev, 'engine-1'))).rejects.toThrow(/untrusted sender/i);
      }
    }

    const onChannels = [PLAYER_CHANNELS.command, PLAYER_CHANNELS.area, PLAYER_CHANNELS.gateReport];
    for (const ch of onChannels) {
      const fn = listeners.get(ch);
      expect(fn).toBeDefined();
      for (const ev of badEvents) {
        expect(() => fn?.(ev, 'ELV_GATE_PLAYER {"ok":true}')).not.toThrow();
      }
    }

    expect(createEngine).not.toHaveBeenCalled();
    expect(gateReport).not.toHaveBeenCalled();
    expect(logs).toHaveLength((handleChannels.length + onChannels.length) * badEvents.length);

    dispose();
  });
});

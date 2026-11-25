import type { DesktopAudioOutputConfig, DisplaySyncPolicy } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import type {
  PlayerBridge,
  PlayerCommandMessage,
  PlayerUiMessage,
} from '../../../src/shared/player-ipc.ts';
import { createDesktopEngine } from './desktop-engine.ts';
import { createDesktopVideoHost } from './desktop-video-host.tsx';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: <T>(s: T): T => s },
}));

function fakeBridge() {
  const sent: PlayerCommandMessage[] = [];
  const uiListeners = new Set<(message: PlayerUiMessage) => void>();
  const bridge: PlayerBridge = {
    open: vi.fn(async () => ({ engineId: 'engine-f7a', mainNowMs: 100 })),
    close: vi.fn(async () => undefined),
    setPrimary: vi.fn(async () => undefined),
    send: (m) => void sent.push(m),
    setArea: () => undefined,
    onEvent: () => () => undefined,
    onUi: (listener) => {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    onRemoteMediaAction: () => () => undefined,
    reportGate: () => undefined,
  };
  const emitUi = (message: PlayerUiMessage) => {
    for (const l of [...uiListeners]) l(message);
  };
  return { bridge, sent, emitUi };
}

describe('Wave F7A DesktopEngine & DesktopVideoHost wiring (#213, #214)', () => {
  it('forwards setDisplaySync, setDesktopAudioOutput, and delivers onPassthroughFallback with unsubscribe and release cleanup', async () => {
    const fake = fakeBridge();
    const engine = await createDesktopEngine(fake.bridge, () => 100);

    const policy: DisplaySyncPolicy = { autoFrameRate: 'seamless', autoDynamicRange: true };
    const audioConfig: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3', 'dts'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: 'auto',
    };

    engine.setDisplaySync(policy);
    engine.setDesktopAudioOutput(audioConfig);

    expect(fake.sent).toEqual([
      { engineId: 'engine-f7a', command: { name: 'setDisplaySync', policy } },
      { engineId: 'engine-f7a', command: { name: 'setDesktopAudioOutput', config: audioConfig } },
    ]);

    const onFallback = vi.fn();
    const off = engine.onPassthroughFallback(onFallback);

    // Other engine's fallback is ignored
    fake.emitUi({ engineId: 'other-engine', ui: { type: 'passthroughFallback' } });
    expect(onFallback).not.toHaveBeenCalled();

    // Matching engine triggers callback
    fake.emitUi({ engineId: 'engine-f7a', ui: { type: 'passthroughFallback' } });
    expect(onFallback).toHaveBeenCalledTimes(1);

    off();
    fake.emitUi({ engineId: 'engine-f7a', ui: { type: 'passthroughFallback' } });
    expect(onFallback).toHaveBeenCalledTimes(1);

    engine.release();
    expect(engine.onPassthroughFallback(vi.fn())).toBeTypeOf('function');
  });

  it('exposes setDisplaySync, setDesktopAudioOutput, and onPassthroughFallback on OpenVideoEngine', async () => {
    const fake = fakeBridge();
    const host = createDesktopVideoHost({ playerBridge: fake.bridge, presenterKind: 'canvas' });
    const opened = await host.open();
    expect(opened).not.toBeNull();

    const policy: DisplaySyncPolicy = { autoFrameRate: 'always', autoDynamicRange: false };
    const audioConfig: DesktopAudioOutputConfig = {
      passthrough: false,
      codecs: ['ac3'],
      exclusive: false,
      ac3Encode: true,
      channelLayout: '5.1',
    };

    opened?.setDisplaySync?.(policy);
    opened?.setDesktopAudioOutput?.(audioConfig);

    expect(fake.sent).toContainEqual({
      engineId: 'engine-f7a',
      command: { name: 'setDisplaySync', policy },
    });
    expect(fake.sent).toContainEqual({
      engineId: 'engine-f7a',
      command: { name: 'setDesktopAudioOutput', config: audioConfig },
    });

    const notice = vi.fn();
    const off = opened?.onPassthroughFallback?.(notice);
    fake.emitUi({ engineId: 'engine-f7a', ui: { type: 'passthroughFallback' } });
    expect(notice).toHaveBeenCalledTimes(1);

    off?.();
    opened?.engine.release();
  });

  it('strips drm from LoadCommand before crossing Electron IPC (#272)', async () => {
    const fake = fakeBridge();
    const engine = await createDesktopEngine(fake.bridge, () => 100);

    engine.load({
      attempt: 1,
      url: 'https://cdn.example.test/live/ch1.mpd',
      headers: { 'User-Agent': 'ElvTest/1.0' },
      kind: 'live',
      drm: {
        scheme: 'clearkey',
        clearKeys: [
          {
            kid: '00112233445566778899aabbccddeeff',
            key: 'ffeeddccbbaa99887766554433221100',
          },
        ],
      },
    });

    expect(fake.sent).toHaveLength(1);
    const loadMsg = fake.sent[0];
    expect(loadMsg?.command.name).toBe('load');
    if (loadMsg?.command.name === 'load') {
      expect('drm' in loadMsg.command.cmd).toBe(false);
      expect(loadMsg.command.cmd).toEqual({
        attempt: 1,
        url: 'https://cdn.example.test/live/ch1.mpd',
        headers: { 'User-Agent': 'ElvTest/1.0' },
        kind: 'live',
      });
    }

    engine.release();
  });
});

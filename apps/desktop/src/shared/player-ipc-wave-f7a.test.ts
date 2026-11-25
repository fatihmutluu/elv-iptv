import { describe, expect, it } from 'vitest';
import { isPlayerCommandMessage } from './player-ipc.ts';

const baseLoad = {
  attempt: 1,
  url: 'https://sim.example.test/live/demo/1001.ts',
  headers: {},
  kind: 'live',
};

const msg = (command: unknown) => ({ engineId: 'engine-1', command });

describe('Wave F7A player IPC guards (#213, #214, #116)', () => {
  it('accepts valid setDisplaySync commands', () => {
    for (const autoFrameRate of ['off', 'seamless', 'always'] as const) {
      for (const autoDynamicRange of [true, false]) {
        expect(
          isPlayerCommandMessage(
            msg({
              name: 'setDisplaySync',
              policy: { autoFrameRate, autoDynamicRange },
            }),
          ),
        ).toBe(true);
      }
    }
  });

  it('rejects malformed, extra-key, or prototype-polluted setDisplaySync commands', () => {
    const polluted = JSON.parse(
      '{"autoFrameRate":"seamless","autoDynamicRange":true,"__proto__":{"polluted":true}}',
    );
    const badCommands: unknown[] = [
      { name: 'setDisplaySync' },
      { name: 'setDisplaySync', policy: null },
      { name: 'setDisplaySync', policy: { autoFrameRate: 'auto', autoDynamicRange: true } },
      { name: 'setDisplaySync', policy: { autoFrameRate: 'seamless', autoDynamicRange: 'yes' } },
      { name: 'setDisplaySync', policy: { autoFrameRate: 'seamless' } },
      {
        name: 'setDisplaySync',
        policy: { autoFrameRate: 'seamless', autoDynamicRange: true, extra: 1 },
      },
      {
        name: 'setDisplaySync',
        policy: { autoFrameRate: 'seamless', autoDynamicRange: true },
        extraKey: 'nope',
      },
      { name: 'setDisplaySync', policy: polluted },
    ];
    for (const command of badCommands) {
      expect(isPlayerCommandMessage(msg(command))).toBe(false);
    }
  });

  it('accepts valid setDesktopAudioOutput commands across all allowlisted codecs and layouts', () => {
    const valid: unknown[] = [
      {
        name: 'setDesktopAudioOutput',
        config: {
          passthrough: false,
          codecs: [],
          exclusive: false,
          ac3Encode: false,
          channelLayout: 'auto',
        },
      },
      {
        name: 'setDesktopAudioOutput',
        config: {
          passthrough: true,
          codecs: ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'],
          exclusive: true,
          ac3Encode: false,
          channelLayout: '7.1',
        },
      },
      {
        name: 'setDesktopAudioOutput',
        config: {
          passthrough: false,
          codecs: ['ac3'],
          exclusive: false,
          ac3Encode: true,
          channelLayout: '5.1',
        },
      },
      {
        name: 'setDesktopAudioOutput',
        config: {
          passthrough: false,
          codecs: ['dts'],
          exclusive: false,
          ac3Encode: false,
          channelLayout: 'stereo',
        },
      },
    ];
    for (const command of valid) {
      expect(isPlayerCommandMessage(msg(command))).toBe(true);
    }
  });

  it('rejects invalid codecs, duplicate codecs, invalid layouts, extra keys, or polluted setDesktopAudioOutput commands', () => {
    const validConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const polluted = JSON.parse(
      '{"passthrough":true,"codecs":["ac3"],"exclusive":false,"ac3Encode":false,"channelLayout":"auto","__proto__":{"x":1}}',
    );
    const badCommands: unknown[] = [
      { name: 'setDesktopAudioOutput' },
      { name: 'setDesktopAudioOutput', config: null },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, passthrough: 'yes' } },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, exclusive: 1 } },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, ac3Encode: 'no' } },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, codecs: 'ac3' } },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, codecs: ['ac3', 'pcm'] } },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, codecs: ['ac3', 'ac3'] } },
      {
        name: 'setDesktopAudioOutput',
        config: { ...validConfig, codecs: ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd', 'ac3'] },
      },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, channelLayout: 'quad' } },
      { name: 'setDesktopAudioOutput', config: { ...validConfig, extra: true } },
      { name: 'setDesktopAudioOutput', config: validConfig, extraKey: true },
      { name: 'setDesktopAudioOutput', config: polluted },
    ];
    for (const command of badCommands) {
      expect(isPlayerCommandMessage(msg(command))).toBe(false);
    }
  });

  it('validates Wave F7A LoadOptions (displaySync, desktopAudioOutput, nightModeDrc) on load commands', () => {
    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: {
            ...baseLoad,
            options: {
              displaySync: { autoFrameRate: 'seamless', autoDynamicRange: true },
              desktopAudioOutput: {
                passthrough: true,
                codecs: ['ac3', 'eac3'],
                exclusive: false,
                ac3Encode: false,
                channelLayout: 'auto',
              },
              nightModeDrc: 'off',
            },
          },
        }),
      ),
    ).toBe(true);

    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: {
            ...baseLoad,
            options: {
              displaySync: { autoFrameRate: 'bogus', autoDynamicRange: true },
            },
          },
        }),
      ),
    ).toBe(false);

    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: {
            ...baseLoad,
            options: {
              desktopAudioOutput: {
                passthrough: true,
                codecs: ['bad'],
                exclusive: false,
                ac3Encode: false,
                channelLayout: 'auto',
              },
            },
          },
        }),
      ),
    ).toBe(false);

    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: {
            ...baseLoad,
            options: {
              nightModeDrc: 'loud',
            },
          },
        }),
      ),
    ).toBe(false);
  });
});

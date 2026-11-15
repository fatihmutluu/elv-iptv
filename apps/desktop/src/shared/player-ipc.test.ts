import { describe, expect, it } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  isGateReport,
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
} from './player-ipc.ts';

const load = {
  attempt: 3,
  url: 'http://sim.test/live/demo/demo/1001.ts',
  headers: { 'User-Agent': 'elv', Referer: 'http://sim.test/' },
  kind: 'live',
};
const msg = (command: unknown) => ({ engineId: 'e1', command });

describe('PLAYER_CHANNELS', () => {
  it('uses the exact channel names', () => {
    expect(PLAYER_CHANNELS).toEqual({
      open: 'player:open',
      close: 'player:close',
      command: 'player:command',
      event: 'player:event',
      area: 'player:area',
      ui: 'player:ui',
      gateReport: 'gate:report',
    });
  });
});

describe('DESKTOP_CAPABILITIES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DESKTOP_CAPABILITIES)).toBe(true);
  });
});

describe('isPlayerCommandMessage', () => {
  it('accepts each BridgeCommand variant', () => {
    const variants: unknown[] = [
      { name: 'load', cmd: load },
      {
        name: 'load',
        cmd: { ...load, kind: 'vod', startMs: 1500, options: { softwareAudio: true } },
      },
      { name: 'retry', attempt: 4 },
      { name: 'play', attempt: 4 },
      { name: 'pause', attempt: 4 },
      { name: 'stop', attempt: 4 },
      { name: 'recreate', attempt: 4 },
      { name: 'seek', attempt: 4, positionMs: 12000 },
      { name: 'release' },
      { name: 'fullscreen' },
    ];
    for (const command of variants) expect(isPlayerCommandMessage(msg(command))).toBe(true);
  });

  it('drops a file: url', () => {
    for (const url of [
      'http:x/a.ts',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
      'ftp://x/y',
    ]) {
      expect(isPlayerCommandMessage(msg({ name: 'load', cmd: { ...load, url } }))).toBe(false);
    }
  });

  it('drops a header value with CR or LF', () => {
    for (const value of ['a\r\nX: 1', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb']) {
      expect(
        isPlayerCommandMessage(
          msg({ name: 'load', cmd: { ...load, headers: { 'X-Key': value } } }),
        ),
      ).toBe(false);
    }
  });

  it('drops a header name that is not an RFC 9110 token', () => {
    for (const name of [
      'X\nKey',
      'X:Key',
      '',
      'X Key\t',
      'X Key',
      'X,Key',
      'X\\Key',
      'X"Key',
      'X(Key)',
      'X/Key',
      'X=Key',
    ]) {
      expect(
        isPlayerCommandMessage(msg({ name: 'load', cmd: { ...load, headers: { [name]: 'v' } } })),
      ).toBe(false);
    }
    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: { ...load, headers: { "X-Key_1.2!#$%&'*+^`|~": 'v' } },
        }),
      ),
    ).toBe(true);
  });

  it('drops an unknown shape', () => {
    const bad: unknown[] = [
      null,
      'load',
      42,
      {},
      { engineId: 'e1' },
      { engineId: '', command: { name: 'release' } },
      { engineId: 7, command: { name: 'release' } },
      msg(null),
      msg({ name: 'explode' }),
      msg({ name: 'play' }),
      msg({ name: 'play', attempt: 'x' }),
      msg({ name: 'play', attempt: -1 }),
      msg({ name: 'play', attempt: 1.5 }),
      msg({ name: 'seek', attempt: 1 }),
      msg({ name: 'seek', attempt: 1, positionMs: Number.NaN }),
      msg({ name: 'seek', attempt: 1, positionMs: -5 }),
      msg({ name: 'load' }),
      msg({ name: 'load', cmd: null }),
      msg({ name: 'load', cmd: { ...load, kind: 'radio' } }),
      msg({ name: 'load', cmd: { ...load, attempt: 'x' } }),
      msg({ name: 'load', cmd: { ...load, headers: null } }),
      msg({ name: 'load', cmd: { ...load, headers: { a: 1 } } }),
      msg({ name: 'load', cmd: { ...load, startMs: -1 } }),
      msg({ name: 'load', cmd: { ...load, startMs: 'x' } }),
      msg({ name: 'load', cmd: { ...load, options: { softwareAudio: 'yes' } } }),
      msg({ name: 'load', cmd: { ...load, options: null } }),
    ];
    for (const m of bad) expect(isPlayerCommandMessage(m)).toBe(false);
  });
});

describe('isPlayerAreaMessage', () => {
  const area = { x: 0, y: 40, width: 800, height: 450, visible: true };

  it('accepts a player area', () => {
    expect(isPlayerAreaMessage({ engineId: 'e1', area })).toBe(true);
  });

  it('drops a malformed area', () => {
    const bad: unknown[] = [
      null,
      { engineId: 'e1' },
      { engineId: '', area },
      { engineId: 'e1', area: null },
      { engineId: 'e1', area: { ...area, x: Number.NaN } },
      { engineId: 'e1', area: { ...area, width: Number.POSITIVE_INFINITY } },
      { engineId: 'e1', area: { ...area, height: '450' } },
      { engineId: 'e1', area: { ...area, x: 1e7 } },
      { engineId: 'e1', area: { ...area, y: -1e7 } },
      { engineId: 'e1', area: { ...area, width: -1 } },
      { engineId: 'e1', area: { ...area, height: -0.5 } },
      { engineId: 'e1', area: { ...area, visible: 1 } },
      { engineId: 'e1', area: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    for (const m of bad) expect(isPlayerAreaMessage(m)).toBe(false);
  });
});

describe('isGateReport', () => {
  it('accepts a gate line', () => {
    expect(isGateReport('ELV_GATE_PLAYER {"verdict":"pass"}')).toBe(true);
  });

  it('drops other text, non-strings and oversized lines', () => {
    expect(isGateReport('hello')).toBe(false);
    expect(isGateReport('ELV_GATE_PLAYER')).toBe(false);
    expect(isGateReport(7)).toBe(false);
    expect(isGateReport('ELV_GATE_PLAYER {"a":1}\nsecond line')).toBe(false);
    expect(isGateReport('ELV_GATE_PLAYER {"a":1}\r')).toBe(false);
    expect(isGateReport(`ELV_GATE_PLAYER {"x":"${'a'.repeat(64 * 1024)}"}`)).toBe(false);
    expect(isGateReport(`ELV_GATE_PLAYER {${'a'.repeat(64 * 1024 - 17)}`)).toBe(true);
  });
});

import { createKeyInterpreter, type Key } from '@elv/focus-core';
import { createAndroidKeyAdapter, mapAndroidKeyCode } from '../android-keys';

const down = (keyCode: number, ageMs = 0) => ({
  action: 'down' as const,
  keyCode,
  canceled: false,
  ageMs,
});
const up = (keyCode: number, ageMs = 0, canceled = false) => ({
  action: 'up' as const,
  keyCode,
  canceled,
  ageMs,
});

const TABLE: [number, Key][] = [
  [19, 'up'],
  [20, 'down'],
  [21, 'left'],
  [22, 'right'],
  [23, 'select'],
  [66, 'select'],
  [160, 'select'],
  [96, 'select'],
  [4, 'back'],
  [97, 'back'],
  [111, 'back'],
  [82, 'menu'],
  [85, 'playPause'],
  [126, 'play'],
  [127, 'pause'],
  [86, 'stop'],
  [87, 'next'],
  [88, 'previous'],
  [89, 'rewind'],
  [90, 'fastForward'],
  [175, 'captions'],
  [222, 'audioTrack'],
  [172, 'guide'],
  [165, 'info'],
  [84, 'search'],
  [229, 'lastChannel'],
  [100, 'search'],
  [102, 'channelDown'],
  [103, 'channelUp'],
  [166, 'channelUp'],
  [92, 'channelUp'],
  [167, 'channelDown'],
  [93, 'channelDown'],
  ...Array.from({ length: 10 }, (_, i): [number, Key] => [7 + i, `digit${i}` as Key]),
  ...Array.from({ length: 10 }, (_, i): [number, Key] => [144 + i, `digit${i}` as Key]),
];

describe('mapAndroidKeyCode', () => {
  it.each(TABLE)('maps the remote key code %i to %s', (code, key) => {
    expect(mapAndroidKeyCode(code)).toBe(key);
  });

  it.each([24, 25, 0])('leaves other codes unmapped (%i)', (code) => {
    expect(mapAndroidKeyCode(code)).toBeUndefined();
  });
});

describe('createAndroidKeyAdapter', () => {
  it('stamps a down with its age', () => {
    const adapt = createAndroidKeyAdapter();
    expect(adapt(down(20, 12), 1000)).toEqual([{ key: 'down', action: 'down', time: 988 }]);
  });

  it('caps back-dating at 100 ms', () => {
    expect(createAndroidKeyAdapter()(down(20, 2000), 5000)).toEqual([
      { key: 'down', action: 'down', time: 4900 },
    ]);
    expect(createAndroidKeyAdapter()(down(20, -5), 1000)).toEqual([
      { key: 'down', action: 'down', time: 1000 },
    ]);
  });

  it('releases a held key', () => {
    const adapt = createAndroidKeyAdapter();
    adapt(down(23), 1000);
    expect(adapt(up(23), 1100)).toEqual([{ key: 'select', action: 'up', time: 1100 }]);
  });

  it('turns a canceled release into cancel', () => {
    const adapt = createAndroidKeyAdapter();
    adapt(down(23), 1000);
    expect(adapt(up(23, 0, true), 1100)).toEqual([{ key: 'select', action: 'cancel', time: 1100 }]);
  });

  it('drops a release whose press it never saw', () => {
    expect(createAndroidKeyAdapter()(up(20), 1000)).toEqual([]);
  });

  it('tracks active keyCodes per Key, ignoring orphan ups of unheld alias codes and releasing only on the last lift', () => {
    const adapt = createAndroidKeyAdapter();
    expect(adapt(down(23), 1000)).toEqual([{ key: 'select', action: 'down', time: 1000 }]);
    expect(adapt(up(66), 1020)).toEqual([]);
    expect(adapt(down(66), 1030)).toEqual([]);
    expect(adapt(up(66), 1100)).toEqual([]);
    expect(adapt(up(23), 1150)).toEqual([{ key: 'select', action: 'up', time: 1150 }]);
  });

  it('preserves raw hold duration across JS stalls so an 80ms tap never becomes backLong and a 600ms hold stays long', () => {
    const adapt = createAndroidKeyAdapter();
    const interpreter = createKeyInterpreter();

    const tapDown = adapt(down(4, 5), 1005);
    const tapUp = adapt(up(4, 525), 1605);
    expect(tapDown).toEqual([{ key: 'back', action: 'down', time: 1000 }]);
    expect(tapUp).toEqual([{ key: 'back', action: 'up', time: 1080 }]);
    expect(tapDown.flatMap((k) => interpreter.input(k))).toEqual([]);
    expect(tapUp.flatMap((k) => interpreter.input(k))).toEqual([
      { key: 'back', kind: 'press', time: 1080 },
    ]);

    const holdDown = adapt(down(4, 700), 1700);
    const holdUp = adapt(up(4, 105), 1705);
    expect(holdDown).toEqual([{ key: 'back', action: 'down', time: 1600 }]);
    expect(holdUp).toEqual([{ key: 'back', action: 'up', time: 2200 }]);
    expect(holdDown.flatMap((k) => interpreter.input(k))).toEqual([]);
    expect(holdUp.flatMap((k) => interpreter.input(k))).toEqual([
      { key: 'back', kind: 'long', time: 2100 },
    ]);
  });

  it('tracks two held keys independently', () => {
    const adapt = createAndroidKeyAdapter();
    adapt(down(20), 1000);
    adapt(down(22), 1010);
    expect(adapt(up(20), 1100)).toEqual([{ key: 'down', action: 'up', time: 1100 }]);
    expect(adapt(up(22), 1200)).toEqual([{ key: 'right', action: 'up', time: 1200 }]);
  });

  it('blur cancels every held key', () => {
    const adapt = createAndroidKeyAdapter();
    adapt(down(20), 1000);
    adapt(down(4), 1010);
    const out = adapt({ action: 'blur' }, 2000);
    expect(out).toHaveLength(2);
    expect(out).toEqual(
      expect.arrayContaining([
        { key: 'down', action: 'cancel', time: 2000 },
        { key: 'back', action: 'cancel', time: 2000 },
      ]),
    );
    expect(adapt(up(20), 2100)).toEqual([]);
  });

  it('ignores unmapped codes', () => {
    const adapt = createAndroidKeyAdapter();
    expect(adapt(down(24), 1000)).toEqual([]);
    expect(adapt(up(24), 1100)).toEqual([]);
  });
});

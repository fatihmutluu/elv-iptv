import type { Key } from '@elv/focus-core';
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
  [126, 'playPause'],
  [127, 'playPause'],
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

  it.each([24, 89, 0])('leaves other codes unmapped (%i)', (code) => {
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

  it('ignores a second down of a held key, also from another code of the same key', () => {
    const adapt = createAndroidKeyAdapter();
    adapt(down(23), 1000);
    expect(adapt(down(66), 1010)).toEqual([]);
    expect(adapt(up(66), 1100)).toEqual([{ key: 'select', action: 'up', time: 1100 }]);
    expect(adapt(up(23), 1110)).toEqual([]);
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

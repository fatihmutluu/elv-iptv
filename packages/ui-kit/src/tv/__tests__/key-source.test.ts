import { toKeyInput } from '../key-source';

describe('toKeyInput', () => {
  it.each([
    ['up', 'up'],
    ['down', 'down'],
    ['left', 'left'],
    ['right', 'right'],
    ['select', 'select'],
    ['playPause', 'playPause'],
    ['menu', 'menu'],
    ['channelUp', 'channelUp'],
    ['channelDown', 'channelDown'],
    ['pageUp', 'channelUp'],
    ['pageDown', 'channelDown'],
  ])('maps %s to %s', (eventType, key) => {
    expect(toKeyInput({ eventType }, 5)).toEqual({ key, action: 'press', time: 5 });
  });

  it('maps eventKeyAction 0 and 1 to down and up', () => {
    expect(toKeyInput({ eventType: 'down', eventKeyAction: 0 }, 1)).toEqual({
      key: 'down',
      action: 'down',
      time: 1,
    });
    expect(toKeyInput({ eventType: 'down', eventKeyAction: 1 }, 2)?.action).toBe('up');
  });

  it('maps native long events to a long action', () => {
    expect(toKeyInput({ eventType: 'longSelect' }, 3)).toEqual({
      key: 'select',
      action: 'long',
      time: 3,
    });
    expect(toKeyInput({ eventType: 'longPlayPause' }, 3)?.key).toBe('playPause');
    expect(toKeyInput({ eventType: 'longDown' }, 3)).toEqual({
      key: 'down',
      action: 'long',
      time: 3,
    });
  });

  it('returns undefined for unknown types and unknown actions', () => {
    expect(toKeyInput({ eventType: 'swipeLeft' }, 0)).toBeUndefined();
    expect(toKeyInput({ eventType: 'pan' }, 0)).toBeUndefined();
    expect(toKeyInput({ eventType: 'longBogus' }, 0)).toBeUndefined();
    expect(toKeyInput({ eventType: 'down', eventKeyAction: 2 }, 0)).toBeUndefined();
    expect(toKeyInput({ eventType: 'down', eventKeyAction: -1 }, 0)).toBeUndefined();
  });
});

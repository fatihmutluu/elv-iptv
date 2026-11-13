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
    expect(toKeyInput({ eventType }, 5, 'android')).toEqual({ key, action: 'press', time: 5 });
  });

  it('maps eventKeyAction 0 and 1 to down and up', () => {
    expect(toKeyInput({ eventType: 'down', eventKeyAction: 0 }, 1, 'android')).toEqual({
      key: 'down',
      action: 'down',
      time: 1,
    });
    expect(toKeyInput({ eventType: 'down', eventKeyAction: 1 }, 2, 'android')?.action).toBe('up');
  });

  it('maps native long events to a long action', () => {
    expect(toKeyInput({ eventType: 'longSelect' }, 3, 'android')).toEqual({
      key: 'select',
      action: 'long',
      time: 3,
    });
    expect(toKeyInput({ eventType: 'longPlayPause' }, 3, 'android')?.key).toBe('playPause');
    expect(toKeyInput({ eventType: 'longDown' }, 3, 'android')).toEqual({
      key: 'down',
      action: 'long',
      time: 3,
    });
  });

  it('keeps an Android native long press start and drops its release', () => {
    expect(toKeyInput({ eventType: 'longDown', eventKeyAction: 0 }, 4, 'android')).toEqual({
      key: 'down',
      action: 'long',
      time: 4,
    });
    expect(toKeyInput({ eventType: 'longDown', eventKeyAction: 1 }, 5, 'android')).toBeUndefined();
    expect(
      toKeyInput({ eventType: 'longSelect', eventKeyAction: 1 }, 5, 'android'),
    ).toBeUndefined();
  });

  it('returns undefined for unknown types and unknown actions', () => {
    expect(toKeyInput({ eventType: 'swipeLeft' }, 0, 'android')).toBeUndefined();
    expect(toKeyInput({ eventType: 'pan' }, 0, 'android')).toBeUndefined();
    expect(toKeyInput({ eventType: 'longBogus' }, 0, 'android')).toBeUndefined();
    expect(toKeyInput({ eventType: 'down', eventKeyAction: 2 }, 0, 'android')).toBeUndefined();
    expect(toKeyInput({ eventType: 'down', eventKeyAction: -1 }, 0, 'android')).toBeUndefined();
  });
  it('treats the tvOS menu button as back and keeps menu on Android', () => {
    expect(toKeyInput({ eventType: 'menu' }, 1, 'ios')).toEqual({
      key: 'back',
      action: 'press',
      time: 1,
    });
    expect(toKeyInput({ eventType: 'longMenu' }, 1, 'ios')).toEqual({
      key: 'back',
      action: 'long',
      time: 1,
    });
    expect(toKeyInput({ eventType: 'menu', eventKeyAction: 0 }, 1, 'android')?.key).toBe('menu');
    expect(toKeyInput({ eventType: 'select' }, 1, 'ios')?.key).toBe('select');
  });
});

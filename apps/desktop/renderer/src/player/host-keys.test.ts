import { describe, expect, it, vi } from 'vitest';
import type { PlayerUiKey } from '../../../src/shared/player-ipc.ts';
import {
  type DesktopHostKey,
  dispatchDesktopClose,
  mapHostKey,
  routeDesktopUiEvent,
} from './host-keys.ts';

describe('mapHostKey, routeDesktopUiEvent & dispatchDesktopClose', () => {
  it('maps every PlayerUiKey cleanly to DesktopHostKey (with close -> back)', () => {
    const cases: ReadonlyArray<readonly [PlayerUiKey, DesktopHostKey]> = [
      ['channel-up', 'channel-up'],
      ['channel-down', 'channel-down'],
      ['back', 'back'],
      ['close', 'back'],
      ['fullscreen', 'fullscreen'],
      ['play-pause', 'play-pause'],
      ['seek-back', 'seek-back'],
      ['seek-forward', 'seek-forward'],
      ['seek-coarse-back', 'seek-coarse-back'],
      ['seek-coarse-forward', 'seek-coarse-forward'],
      ['mute', 'mute'],
      ['tracks', 'tracks'],
      ['prev-channel', 'prev-channel'],
    ];
    for (const [input, expected] of cases) {
      expect(mapHostKey(input)).toBe(expected);
    }
  });

  it('separates close/closed from back and routes fullscreen, channel zaps, and transport/OSD host keys cleanly', () => {
    const onHostKey = vi.fn<(key: DesktopHostKey) => void>();
    const toggleFullscreen = vi.fn(() => onHostKey('fullscreen'));
    const onClose = vi.fn();
    const handlers = { toggleFullscreen, onHostKey, onClose };

    routeDesktopUiEvent({ type: 'presenter', kind: 'child-window', coversArea: true }, handlers);
    expect(toggleFullscreen).not.toHaveBeenCalled();
    expect(onHostKey).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    routeDesktopUiEvent({ type: 'key', key: 'fullscreen' }, handlers);
    expect(toggleFullscreen).toHaveBeenCalledTimes(1);

    const forwarded: readonly DesktopHostKey[] = [
      'channel-up',
      'channel-down',
      'back',
      'play-pause',
      'seek-back',
      'seek-forward',
      'seek-coarse-back',
      'seek-coarse-forward',
      'mute',
      'tracks',
      'prev-channel',
    ];
    for (const key of forwarded) {
      routeDesktopUiEvent({ type: 'key', key }, handlers);
    }
    expect(onHostKey.mock.calls).toEqual([['fullscreen'], ...forwarded.map((k) => [k])]);
    expect(onClose).not.toHaveBeenCalled();

    routeDesktopUiEvent({ type: 'key', key: 'close' }, handlers);
    routeDesktopUiEvent({ type: 'closed' }, handlers);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onHostKey).toHaveBeenCalledTimes(1 + forwarded.length);
  });

  it('dispatchDesktopClose sends back once normally, or twice when track picker modal is open', () => {
    const keys: string[] = [];
    dispatchDesktopClose((k) => keys.push(k), false);
    expect(keys).toEqual(['back']);

    keys.length = 0;
    dispatchDesktopClose((k) => keys.push(k), true);
    expect(keys).toEqual(['back', 'back']);
  });
});

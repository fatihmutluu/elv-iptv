import { resolveRemappedAction, setKeyBinding } from '@elv/focus-core';
import { describe, expect, it } from 'vitest';
import {
  evaluateRemappedEvent,
  formatRemoteKeyLabel,
  mapWebKeyToRemoteKey,
} from './keymap-routing';

describe('keymap-routing (#33)', () => {
  it('resolves explicit user overrides, global fallback, and suppresses unbound or moved defaults', () => {
    const rebound = setKeyBinding({}, 'player.toggleMute', { key: 'colorRed', kind: 'press' });
    expect(evaluateRemappedEvent(rebound, 'player', { key: 'colorRed', kind: 'press' })).toEqual({
      status: 'remapped',
      actionId: 'player.toggleMute',
    });
    // Old default trigger for player.toggleMute (colorYellow) is suppressed
    expect(evaluateRemappedEvent(rebound, 'player', { key: 'colorYellow', kind: 'press' })).toEqual(
      { status: 'suppressed' },
    );

    const unbound = setKeyBinding({}, 'live.lastChannel', null);
    expect(evaluateRemappedEvent(unbound, 'live', { key: 'lastChannel', kind: 'press' })).toEqual({
      status: 'suppressed',
    });

    const globalRebind = setKeyBinding({}, 'global.openHome', { key: 'info', kind: 'long' });
    expect(evaluateRemappedEvent(globalRebind, 'live', { key: 'info', kind: 'long' })).toEqual({
      status: 'remapped',
      actionId: 'global.openHome',
    });

    expect(evaluateRemappedEvent({}, 'player', { key: 'playPause', kind: 'press' })).toEqual({
      status: 'default',
      actionId: 'player.togglePlayPause',
    });

    expect(evaluateRemappedEvent(rebound, 'player', { key: 'colorRed', kind: 'repeat' })).toEqual({
      status: 'default',
      actionId: null,
    });
  });

  it('matches resolveRemappedAction precedence strictly: local defaults beat global overrides unless unbound', () => {
    const globalOverride = setKeyBinding({}, 'global.openHome', { key: 'info', kind: 'press' });
    const event = { key: 'info', kind: 'press' } as const;

    // In player context, un-overridden player.openInfo (default: info) beats global.openHome override
    expect(resolveRemappedAction(globalOverride, 'player', event)).toBe('player.openInfo');
    expect(evaluateRemappedEvent(globalOverride, 'player', event)).toEqual({
      status: 'default',
      actionId: 'player.openInfo',
    });

    // Once player.openInfo is explicitly unbound, global.openHome wins
    const withLocalUnbound = setKeyBinding(globalOverride, 'player.openInfo', null);
    expect(resolveRemappedAction(withLocalUnbound, 'player', event)).toBe('global.openHome');
    expect(evaluateRemappedEvent(withLocalUnbound, 'player', event)).toEqual({
      status: 'remapped',
      actionId: 'global.openHome',
    });
  });

  it('maps web keyboard keys to logical remote keys', () => {
    expect(mapWebKeyToRemoteKey('p')).toBe('lastChannel');
    expect(mapWebKeyToRemoteKey('P')).toBe('lastChannel');
    expect(mapWebKeyToRemoteKey('Escape')).toBe('back');
    expect(mapWebKeyToRemoteKey('PageUp')).toBe('channelUp');
    expect(mapWebKeyToRemoteKey('x')).toBeNull();
  });

  it('formats hardware key labels cleanly', () => {
    expect(formatRemoteKeyLabel('playPause')).toBe('Play / Pause');
    expect(formatRemoteKeyLabel('channelUp')).toBe('CH+');
    expect(formatRemoteKeyLabel('colorBlue')).toBe('Blue');
    expect(formatRemoteKeyLabel('digit5')).toBe('5');
  });
});

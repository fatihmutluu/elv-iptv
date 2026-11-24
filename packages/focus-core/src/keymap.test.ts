import { describe, expect, it } from 'vitest';
import {
  collectLongPressKeys,
  DEFAULT_KEY_BINDINGS,
  findConflictingActions,
  isImmutableNavTrigger,
  type KeymapOverrides,
  type KeyTrigger,
  parseKeymapOverrides,
  REMAPPABLE_ACTIONS,
  type RemappableActionId,
  resetAllKeyBindings,
  resetKeyBinding,
  resolveKeyTrigger,
  resolveRemappedAction,
  setKeyBinding,
  validateKeyBinding,
} from './keymap';
import { ARROW_KEYS, type Key } from './keys';

describe('@elv/focus-core keymap', () => {
  it('defines metadata and default bindings for all player, live, and global actions', () => {
    const ids = REMAPPABLE_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining<RemappableActionId>([
        'player.togglePlayPause',
        'player.seekBack',
        'player.seekForward',
        'player.channelUp',
        'player.channelDown',
        'player.lastChannel',
        'player.openChannelDrawer',
        'player.openSettings',
        'player.cycleAudioTrack',
        'player.cycleSubtitleTrack',
        'player.toggleMute',
        'player.openInfo',
        'player.toggleGuide',
        'live.lastChannel',
        'live.toggleGuide',
        'live.openSearch',
        'live.toggleFavorite',
        'global.openSearch',
        'global.openGuide',
        'global.openHome',
      ]),
    );

    for (const meta of REMAPPABLE_ACTIONS) {
      expect(DEFAULT_KEY_BINDINGS[meta.id]).toEqual(meta.defaultTrigger);
      if (meta.defaultTrigger !== null) {
        expect(isImmutableNavTrigger(meta.defaultTrigger)).toBe(false);
        expect(validateKeyBinding(meta.id, meta.defaultTrigger)).toEqual({ ok: true });
      }
    }
  });

  it('enforces immutable navigation safety for short presses on arrows, select, and back', () => {
    const immutableKeys: readonly Key[] = [...ARROW_KEYS, 'select', 'back'];
    for (const key of immutableKeys) {
      expect(isImmutableNavTrigger({ key, kind: 'press' })).toBe(true);
      expect(validateKeyBinding('player.openSettings', { key, kind: 'press' })).toEqual({
        ok: false,
        reason: 'immutable-nav-key',
      });

      expect(isImmutableNavTrigger({ key, kind: 'long' })).toBe(false);
      expect(validateKeyBinding('player.openSettings', { key, kind: 'long' })).toEqual({
        ok: true,
      });
    }

    const allowedShortKeys: readonly Key[] = [
      'colorRed',
      'colorGreen',
      'colorYellow',
      'colorBlue',
      'guide',
      'info',
      'menu',
      'lastChannel',
      'channelUp',
      'channelDown',
      'audioTrack',
      'captions',
      'search',
      'playPause',
      'rewind',
      'fastForward',
      'digit0',
      'digit9',
    ];
    for (const key of allowedShortKeys) {
      expect(isImmutableNavTrigger({ key, kind: 'press' })).toBe(false);
      expect(validateKeyBinding('player.openSettings', { key, kind: 'press' })).toEqual({
        ok: true,
      });
    }

    expect(validateKeyBinding('player.openSettings', null)).toEqual({ ok: true });
    expect(validateKeyBinding('unknown.action' as RemappableActionId, null)).toEqual({
      ok: false,
      reason: 'unknown-action',
    });
  });

  it('resolves default and overridden triggers and ignores repeat events', () => {
    expect(resolveKeyTrigger({}, 'player.togglePlayPause')).toEqual({
      key: 'playPause',
      kind: 'press',
    });

    expect(resolveRemappedAction({}, 'player', { key: 'playPause', kind: 'press' })).toBe(
      'player.togglePlayPause',
    );

    expect(resolveRemappedAction({}, 'player', { key: 'playPause', kind: 'repeat' })).toBeNull();

    // Context actions take precedence over global actions, and global acts as fallback.
    expect(resolveRemappedAction({}, 'player', { key: 'guide', kind: 'press' })).toBe(
      'player.toggleGuide',
    );
    expect(resolveRemappedAction({}, 'player', { key: 'search', kind: 'press' })).toBe(
      'global.openSearch',
    );
    expect(resolveRemappedAction({}, 'live', { key: 'search', kind: 'press' })).toBe(
      'live.openSearch',
    );
    expect(resolveRemappedAction({}, 'global', { key: 'search', kind: 'press' })).toBe(
      'global.openSearch',
    );

    // Explicitly unbound action does not fall back to default.
    const unbound: KeymapOverrides = { 'player.togglePlayPause': null };
    expect(resolveKeyTrigger(unbound, 'player.togglePlayPause')).toBeNull();
    expect(
      resolveRemappedAction(unbound, 'player', { key: 'playPause', kind: 'press' }),
    ).toBeNull();
  });

  it('sets bindings, auto-displaces conflicts within same context or global, and prunes defaults', () => {
    // Rebind player.openSettings to guide -> displaces player.toggleGuide and global.openGuide.
    const guideTrigger: KeyTrigger = { key: 'guide', kind: 'press' };
    expect(findConflictingActions({}, 'player.openSettings', guideTrigger)).toEqual([
      'player.toggleGuide',
      'global.openGuide',
    ]);

    const afterRebind = setKeyBinding({}, 'player.openSettings', guideTrigger);
    expect(afterRebind['player.openSettings']).toEqual(guideTrigger);
    expect(afterRebind['player.toggleGuide']).toBeNull();
    expect(afterRebind['global.openGuide']).toBeNull();
    // Live context is unaffected.
    expect(resolveKeyTrigger(afterRebind, 'live.toggleGuide')).toEqual(guideTrigger);
    expect(resolveRemappedAction(afterRebind, 'player', guideTrigger)).toBe('player.openSettings');

    // Setting back to default prunes the override entry so storage stays sparse.
    const defaultSettings = DEFAULT_KEY_BINDINGS['player.openSettings'];
    const pruned = setKeyBinding(afterRebind, 'player.openSettings', defaultSettings);
    expect('player.openSettings' in pruned).toBe(false);

    // Immutable nav trigger is rejected without mutating overrides.
    const rejected = setKeyBinding(afterRebind, 'player.openSettings', {
      key: 'select',
      kind: 'press',
    });
    expect(rejected).toBe(afterRebind);
  });

  it('resets individual bindings and resets all bindings cleanly', () => {
    const custom = setKeyBinding({}, 'live.toggleFavorite', { key: 'colorYellow', kind: 'press' });
    expect(custom['live.toggleFavorite']).toEqual({ key: 'colorYellow', kind: 'press' });

    const afterSingleReset = resetKeyBinding(custom, 'live.toggleFavorite');
    expect(afterSingleReset).toEqual({});

    expect(resetAllKeyBindings()).toEqual({});
  });

  it('displaces conflicting same-context and global/local bindings when resetKeyBinding restores a default trigger', () => {
    // 1. Same-context conflict: player.openSettings moved off colorBlue, player.toggleMute moved onto colorBlue.
    const movedSettings = setKeyBinding({}, 'player.openSettings', {
      key: 'colorRed',
      kind: 'press',
    });
    const muteOnBlue = setKeyBinding(movedSettings, 'player.toggleMute', {
      key: 'colorBlue',
      kind: 'press',
    });
    // Also bind an unrelated live action to colorBlue to confirm cross-local contexts stay intact.
    const withLiveBlue = setKeyBinding(muteOnBlue, 'live.toggleFavorite', {
      key: 'colorBlue',
      kind: 'press',
    });
    const resetSettings = resetKeyBinding(withLiveBlue, 'player.openSettings');
    expect('player.openSettings' in resetSettings).toBe(false);
    expect(resetSettings['player.toggleMute']).toBeNull();
    expect(resolveKeyTrigger(resetSettings, 'player.openSettings')).toEqual({
      key: 'colorBlue',
      kind: 'press',
    });
    expect(resolveKeyTrigger(resetSettings, 'player.toggleMute')).toBeNull();
    expect(
      resolveRemappedAction(resetSettings, 'player', { key: 'colorBlue', kind: 'press' }),
    ).toBe('player.openSettings');
    expect(resolveKeyTrigger(resetSettings, 'live.toggleFavorite')).toEqual({
      key: 'colorBlue',
      kind: 'press',
    });

    // 2. Local -> global conflict: player.openSettings rebound to colorGreen (displaces global.openHome),
    // then resetting global.openHome displaces player.openSettings.
    const settingsOnGreen = setKeyBinding({}, 'player.openSettings', {
      key: 'colorGreen',
      kind: 'press',
    });
    expect(settingsOnGreen['global.openHome']).toBeNull();
    const resetGlobalHome = resetKeyBinding(settingsOnGreen, 'global.openHome');
    expect('global.openHome' in resetGlobalHome).toBe(false);
    expect(resetGlobalHome['player.openSettings']).toBeNull();
    expect(
      resolveRemappedAction(resetGlobalHome, 'player', { key: 'colorGreen', kind: 'press' }),
    ).toBe('global.openHome');

    // 3. Global -> local conflict: global.openHome rebound to colorBlue while player.openSettings is on colorRed,
    // then resetting player.openSettings displaces global.openHome.
    const globalOnBlue = setKeyBinding(movedSettings, 'global.openHome', {
      key: 'colorBlue',
      kind: 'press',
    });
    const resetLocalSettings = resetKeyBinding(globalOnBlue, 'player.openSettings');
    expect('player.openSettings' in resetLocalSettings).toBe(false);
    expect(resetLocalSettings['global.openHome']).toBeNull();

    // 4. Shared defaults (e.g. guide on player.toggleGuide & global.openGuide) stay intact when resetting.
    const guideMoved = setKeyBinding({}, 'player.toggleGuide', { key: 'colorRed', kind: 'press' });
    expect(resetKeyBinding(guideMoved, 'player.toggleGuide')).toEqual({});
  });

  it('collects default long-press keys plus any keys bound with kind long', () => {
    const defaults = collectLongPressKeys({});
    expect(defaults).toEqual(expect.arrayContaining(['select', 'back', ...ARROW_KEYS]));

    const withLong = setKeyBinding({}, 'player.openSettings', { key: 'menu', kind: 'long' });
    const withLongColor = setKeyBinding(withLong, 'live.toggleFavorite', {
      key: 'colorRed',
      kind: 'long',
    });
    const collected = collectLongPressKeys(withLongColor);
    expect(collected).toContain('menu');
    expect(collected).toContain('colorRed');
    expect(collected).toContain('select');
    expect(new Set(collected).size).toBe(collected.length);

    // Digit keys bound as long are ignored in longKeys collection (interpreter excludes digits).
    const withDigitLong = setKeyBinding({}, 'player.openInfo', { key: 'digit5', kind: 'long' });
    expect(collectLongPressKeys(withDigitLong)).not.toContain('digit5');
  });

  it('sanitizes untrusted overrides via parseKeymapOverrides', () => {
    expect(parseKeymapOverrides(null)).toEqual({});
    expect(parseKeymapOverrides('invalid')).toEqual({});
    expect(parseKeymapOverrides([1, 2, 3])).toEqual({});

    const parsed = parseKeymapOverrides({
      'player.openSettings': { key: 'colorRed', kind: 'long' },
      'player.togglePlayPause': null,
      // Equal to default -> pruned
      'player.seekBack': { key: 'rewind', kind: 'press' },
      // Immutable nav key -> rejected
      'player.seekForward': { key: 'back', kind: 'press' },
      // Invalid key or kind -> rejected
      'player.openInfo': { key: 'notAKey', kind: 'press' },
      'player.toggleMute': { key: 'menu', kind: 'repeat' },
      // Unknown action -> rejected
      'unknown.action': { key: 'colorRed', kind: 'press' },
      __proto__: { key: 'colorRed', kind: 'press' },
    });

    expect(parsed).toEqual({
      'player.openSettings': { key: 'colorRed', kind: 'long' },
      'player.togglePlayPause': null,
    });
  });
});

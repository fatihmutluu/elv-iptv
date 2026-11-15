import { type Key, type KeyInput, LONG_PRESS_MS } from '@elv/focus-core';
import { useContext, useEffect, useRef } from 'react';
import { BackHandler, Platform, TVEventControl, TVEventHandler } from 'react-native';
import { createAndroidKeyAdapter } from './android-keys';
import { RemoteKeysContext } from './RemoteKeysProvider';
import { TextEntryContext } from './text-entry';
import { subscribeWebKeys, type WebKeyWindowLike } from './web-keys';

/** Platforms whose remote events differ: on tvOS the Menu button is Back. */
export type TvPlatform = 'ios' | 'android';

const KEYS: Readonly<Record<string, Key>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  playPause: 'playPause',
  play: 'play',
  pause: 'pause',
  rewind: 'rewind',
  fastForward: 'fastForward',
  menu: 'menu',
  channelUp: 'channelUp',
  channelDown: 'channelDown',
  pageUp: 'channelUp',
  pageDown: 'channelDown',
};

const RAW_BACK_DEDUP_MS = 1000;

let tvMenuKeyUsers = 0;

function retainTvMenuKey(): () => void {
  tvMenuKeyUsers += 1;
  if (tvMenuKeyUsers === 1) TVEventControl?.enableTVMenuKey?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    tvMenuKeyUsers = Math.max(0, tvMenuKeyUsers - 1);
    if (tvMenuKeyUsers === 0) TVEventControl?.disableTVMenuKey?.();
  };
}

function platformKey(key: Key | undefined, platform: TvPlatform): Key | undefined {
  return platform === 'ios' && key === 'menu' ? 'back' : key;
}

/**
 * Converts a react-native-tvos remote event into a focus-core `KeyInput`, or `undefined` for events the focus core
 * does not use, with the tvOS Menu button (and its native long press) reported as `back`. Swipes, pans and unknown
 * types give `undefined`. `eventKeyAction` 0 and 1 (Android) become `down` and `up` (on Android TV a tap arrives only
 * as the `up`); events without it (tvOS) are presses. A `long*` event becomes one native `long` action; on Android its
 * release (`eventKeyAction` 1) gives `undefined`, since the long press already fired with action 0.
 */
export function toKeyInput(
  native: { eventType: string; eventKeyAction?: number },
  now: number,
  platform: TvPlatform,
): KeyInput | undefined {
  const { eventType, eventKeyAction } = native;
  if (eventType.startsWith('long') && eventType.length > 4) {
    if (eventKeyAction === 1) return undefined;
    const rest = eventType.charAt(4).toLowerCase() + eventType.slice(5);
    const key = platformKey(KEYS[rest], platform);
    return key ? { key, action: 'long', time: now } : undefined;
  }
  const key = platformKey(KEYS[eventType], platform);
  if (!key) return undefined;
  if (eventKeyAction === undefined) return { key, action: 'press', time: now };
  if (eventKeyAction === 0) return { key, action: 'down', time: now };
  if (eventKeyAction === 1) return { key, action: 'up', time: now };
  return undefined;
}

/**
 * Feeds remote keys to `onInput`, suspending non-`back` keys while a `TvTextInput` / `TextEntryBoundary` session is
 * active (#48). Supports Android raw `RemoteKeysProvider` (with standalone `BackHandler` synthesis for Predictive Back
 * or TalkBack), `TVEventHandler` on tvOS/Android (with refcounted `TVEventControl` menu key), and DOM keyboard events
 * on `react-native-web` (`Platform.OS === 'web'`).
 */
export function useTvKeySource(onInput: (k: KeyInput) => void): void {
  const handler = useRef(onInput);
  handler.current = onInput;
  const raw = useContext(RemoteKeysContext);
  const textEntry = useContext(TextEntryContext);

  useEffect(() => {
    const deliveredHeld = new Set<Key>();
    const suppressedDowns = new Set<Key>();
    let textEntryBackDownAt: number | undefined;

    const forward = (input: KeyInput, requirePriorDown: boolean): void => {
      if (input.key !== 'back') {
        if (textEntry.isActive()) {
          if (input.action === 'down') suppressedDowns.add(input.key);
          else if (input.action === 'up' || input.action === 'cancel') {
            suppressedDowns.delete(input.key);
            deliveredHeld.delete(input.key);
          }
          return;
        }
        if (input.action === 'down') {
          suppressedDowns.delete(input.key);
          deliveredHeld.add(input.key);
          handler.current(input);
          return;
        }
        if (input.action === 'up') {
          if (suppressedDowns.delete(input.key)) return;
          if (requirePriorDown && !deliveredHeld.delete(input.key)) return;
          deliveredHeld.delete(input.key);
          handler.current(input);
          return;
        }
        if (input.action === 'cancel') {
          suppressedDowns.delete(input.key);
          if (!requirePriorDown || deliveredHeld.delete(input.key)) handler.current(input);
          return;
        }
        handler.current(input);
        return;
      }

      if (input.action === 'press') {
        if (textEntry.isActive()) {
          textEntry.exit();
          return;
        }
        handler.current(input);
        return;
      }
      if (input.action === 'long') {
        handler.current(input);
        return;
      }
      if (input.action === 'down') {
        textEntryBackDownAt = textEntry.isActive() ? input.time : undefined;
        deliveredHeld.add('back');
        handler.current(input);
        return;
      }
      if (input.action === 'up') {
        if (requirePriorDown && !deliveredHeld.delete('back')) return;
        deliveredHeld.delete('back');
        const downAt = textEntryBackDownAt;
        textEntryBackDownAt = undefined;
        if (downAt !== undefined) {
          if (input.time - downAt < LONG_PRESS_MS) {
            if (textEntry.isActive()) textEntry.exit();
            handler.current({ key: 'back', action: 'cancel', time: input.time });
            return;
          }
          handler.current(input);
          return;
        }
        if (textEntry.isActive()) {
          textEntry.exit();
          handler.current({ key: 'back', action: 'cancel', time: input.time });
          return;
        }
        handler.current(input);
        return;
      }
      textEntryBackDownAt = undefined;
      if (!requirePriorDown || deliveredHeld.delete('back')) handler.current(input);
    };

    const offEnter = textEntry.onEnter(() => {
      const t = performance.now();
      for (const key of [...deliveredHeld]) {
        if (key === 'back') continue;
        deliveredHeld.delete(key);
        suppressedDowns.add(key);
        handler.current({ key, action: 'cancel', time: t });
      }
    });

    const cancelRemaining = (): void => {
      const t = performance.now();
      for (const key of deliveredHeld) handler.current({ key, action: 'cancel', time: t });
      deliveredHeld.clear();
      suppressedDowns.clear();
      textEntryBackDownAt = undefined;
    };

    if ((Platform.OS as string) === 'web') {
      const win = (globalThis as { window?: WebKeyWindowLike }).window;
      const offWeb =
        win && typeof win.addEventListener === 'function'
          ? subscribeWebKeys(
              win,
              textEntry,
              () => performance.now(),
              (k) => forward(k, true),
            )
          : undefined;
      return () => {
        offEnter();
        offWeb?.();
        cancelRemaining();
      };
    }

    if (Platform.OS === 'android' && raw) {
      const adapt = createAndroidKeyAdapter();
      let rawBackHeld = false;
      let pendingRawBackUp = false;
      let lastRawBackUpAt = 0;

      const sub = raw.addListener((event) => {
        const now = performance.now();
        if (event.action === 'blur') {
          rawBackHeld = false;
          pendingRawBackUp = false;
        }
        for (const input of adapt(event, now)) {
          if (input.key === 'back') {
            if (input.action === 'down') rawBackHeld = true;
            else if (input.action === 'up') {
              rawBackHeld = false;
              pendingRawBackUp = true;
              lastRawBackUpAt = now;
            } else if (input.action === 'cancel') {
              rawBackHeld = false;
              pendingRawBackUp = false;
            }
          }
          forward(input, true);
        }
      });
      const consume = BackHandler?.addEventListener?.('hardwareBackPress', () => {
        const now = performance.now();
        if (rawBackHeld) return true;
        if (pendingRawBackUp && now - lastRawBackUpAt < RAW_BACK_DEDUP_MS) {
          pendingRawBackUp = false;
          return true;
        }
        pendingRawBackUp = false;
        forward({ key: 'back', action: 'press', time: now }, false);
        return true;
      });
      return () => {
        offEnter();
        for (const input of adapt({ action: 'blur' }, performance.now())) forward(input, true);
        cancelRemaining();
        sub.remove();
        consume?.remove();
      };
    }

    const releaseMenu = Platform.OS === 'ios' && Platform.isTV ? retainTvMenuKey() : undefined;
    const remote = TVEventHandler?.addListener?.((event) => {
      const input = toKeyInput(event, performance.now(), Platform.OS === 'ios' ? 'ios' : 'android');
      if (input) forward(input, false);
    });
    const back = BackHandler?.addEventListener?.('hardwareBackPress', () => {
      forward({ key: 'back', action: 'press', time: performance.now() }, false);
      return true;
    });
    return () => {
      offEnter();
      cancelRemaining();
      remote?.remove();
      back?.remove();
      releaseMenu?.();
    };
  }, [raw, textEntry]);
}

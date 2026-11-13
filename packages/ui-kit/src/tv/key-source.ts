import type { Key, KeyInput } from '@elv/focus-core';
import { useEffect, useRef } from 'react';
import { BackHandler, Platform, TVEventControl, TVEventHandler } from 'react-native';

const KEYS: Readonly<Record<string, Key>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  playPause: 'playPause',
  menu: 'menu',
  channelUp: 'channelUp',
  channelDown: 'channelDown',
  pageUp: 'channelUp',
  pageDown: 'channelDown',
};

/**
 * Converts a react-native-tvos remote event into a focus-core `KeyInput`, or `undefined` for events the focus core
 * does not use (swipes, pans, unknown types). `eventKeyAction` 0 and 1 (Android) become `down` and `up`; events
 * without it (tvOS) are presses; `long*` events (tvOS) become one native `long` action.
 */
export function toKeyInput(
  native: { eventType: string; eventKeyAction?: number },
  now: number,
): KeyInput | undefined {
  const { eventType, eventKeyAction } = native;
  if (eventType.startsWith('long') && eventType.length > 4) {
    const rest = eventType.charAt(4).toLowerCase() + eventType.slice(5);
    const key = KEYS[rest];
    return key ? { key, action: 'long', time: now } : undefined;
  }
  const key = KEYS[eventType];
  if (!key) return undefined;
  if (eventKeyAction === undefined) return { key, action: 'press', time: now };
  if (eventKeyAction === 0) return { key, action: 'down', time: now };
  if (eventKeyAction === 1) return { key, action: 'up', time: now };
  return undefined;
}

/**
 * Feeds remote keys to `onInput`: `TVEventHandler` for the remote, `BackHandler` for Android's Back (consumed, sent
 * as a `back` press), and the menu key on tvOS enabled for the lifetime of the hook.
 */
export function useTvKeySource(onInput: (k: KeyInput) => void): void {
  const handler = useRef(onInput);
  handler.current = onInput;

  useEffect(() => {
    const tvos = Platform.OS === 'ios' && Platform.isTV;
    if (tvos) TVEventControl.enableTVMenuKey();
    const remote = TVEventHandler.addListener((event) => {
      const input = toKeyInput(event, Date.now());
      if (input) handler.current(input);
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      handler.current({ key: 'back', action: 'press', time: Date.now() });
      return true;
    });
    return () => {
      remote.remove();
      back.remove();
      if (tvos) TVEventControl.disableTVMenuKey();
    };
  }, []);
}

import { type Key, type KeyInput, LONG_PRESS_MS } from '@elv/focus-core';
import { useContext, useEffect, useRef } from 'react';
import { RemoteKeysContext } from './RemoteKeysProvider';
import {
  isEventTextEntryConsumed,
  markEventConsumed,
  markEventTextEntryConsumed,
  TvRemoteContext,
  type TvRemoteEvent,
} from './remote-context';
import { attachPlatformKeySource, type TvPlatform, toKeyInput } from './remote-dispatcher';
import { TextEntryContext } from './text-entry';

export { type TvPlatform, toKeyInput };

/**
 * Feeds remote keys to `onInput`, suspending non-`back` keys while a `TvTextInput` / `TextEntryBoundary` session is
 * active (#48). When rendered inside {@link TvRemoteProvider}, subscribes to its shared root dispatcher with zero
 * additional native/web listeners (#277); outside a provider, attaches a direct platform listener fallback.
 */
export function useTvKeySource(
  onInput: ((k: KeyInput) => boolean | undefined) | ((k: KeyInput) => void),
): void {
  const handler = useRef(onInput);
  handler.current = onInput;
  const dispatcher = useContext(TvRemoteContext);
  const raw = useContext(RemoteKeysContext);
  const textEntry = useContext(TextEntryContext);
  const fallbackRaw = dispatcher === null ? raw : null;

  useEffect(() => {
    const deliveredHeld = new Set<Key>();
    const suppressedDowns = new Set<Key>();
    let textEntryBackDownAt: number | undefined;

    const forward = (
      input: KeyInput,
      requirePriorDown: boolean,
      remoteEvent?: TvRemoteEvent,
    ): boolean => {
      const deliver = (k: KeyInput): boolean => {
        const consumed = handler.current(k) !== false;
        if (consumed && remoteEvent !== undefined) markEventConsumed(remoteEvent);
        return consumed;
      };

      if (input.key !== 'back') {
        if (textEntry.isActive()) {
          if (input.action === 'down') suppressedDowns.add(input.key);
          else if (input.action === 'up' || input.action === 'cancel') {
            suppressedDowns.delete(input.key);
            deliveredHeld.delete(input.key);
          }
          return false;
        }
        if (input.action === 'down') {
          suppressedDowns.delete(input.key);
          deliveredHeld.add(input.key);
          return deliver(input);
        }
        if (input.action === 'up') {
          if (suppressedDowns.delete(input.key)) return false;
          if (requirePriorDown && !deliveredHeld.delete(input.key)) return false;
          deliveredHeld.delete(input.key);
          return deliver(input);
        }
        if (input.action === 'cancel') {
          suppressedDowns.delete(input.key);
          if (!requirePriorDown || deliveredHeld.delete(input.key)) return deliver(input);
          return false;
        }
        return deliver(input);
      }

      if (input.action === 'press') {
        if (remoteEvent !== undefined && isEventTextEntryConsumed(remoteEvent)) return true;
        if (textEntry.isActive()) {
          if (remoteEvent !== undefined) markEventTextEntryConsumed(remoteEvent);
          textEntry.exit();
          return true;
        }
        return deliver(input);
      }
      if (input.action === 'long') {
        return deliver(input);
      }
      if (input.action === 'down') {
        textEntryBackDownAt = textEntry.isActive() ? input.time : undefined;
        deliveredHeld.add('back');
        return deliver(input);
      }
      if (input.action === 'up') {
        if (requirePriorDown && !deliveredHeld.delete('back')) return false;
        deliveredHeld.delete('back');
        const downAt = textEntryBackDownAt;
        textEntryBackDownAt = undefined;
        if (remoteEvent !== undefined && isEventTextEntryConsumed(remoteEvent)) {
          handler.current({ key: 'back', action: 'cancel', time: input.time });
          return true;
        }
        if (downAt !== undefined) {
          if (input.time - downAt < LONG_PRESS_MS) {
            if (remoteEvent !== undefined) markEventTextEntryConsumed(remoteEvent);
            if (textEntry.isActive()) textEntry.exit();
            handler.current({ key: 'back', action: 'cancel', time: input.time });
            return true;
          }
          return deliver(input);
        }
        if (textEntry.isActive()) {
          if (remoteEvent !== undefined) markEventTextEntryConsumed(remoteEvent);
          textEntry.exit();
          handler.current({ key: 'back', action: 'cancel', time: input.time });
          return true;
        }
        return deliver(input);
      }
      textEntryBackDownAt = undefined;
      if (!requirePriorDown || deliveredHeld.delete('back')) return deliver(input);
      return false;
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

    if (dispatcher !== null) {
      const unregisterTextEntry = dispatcher.registerTextEntry(textEntry);
      const unsubscribe = dispatcher.subscribe((event) =>
        forward(event.input, event.requirePriorDown, event),
      );
      return () => {
        offEnter();
        unsubscribe();
        unregisterTextEntry();
        cancelRemaining();
      };
    }

    const detach = attachPlatformKeySource({
      raw: fallbackRaw,
      isTextEntryActive: () => textEntry.isActive(),
      emit: forward,
    });
    return () => {
      offEnter();
      detach();
      cancelRemaining();
    };
  }, [dispatcher, fallbackRaw, textEntry]);
}

import { type Key, type KeyInput, LONG_PRESS_MS } from '@elv/focus-core';
import { useContext, useEffect, useRef } from 'react';
import { RemoteKeysContext } from './RemoteKeysProvider';
import {
  attachPlatformKeySource,
  type TvPlatform,
  TvRemoteContext,
  toKeyInput,
} from './remote-dispatcher';
import { TextEntryContext } from './text-entry';

export { type TvPlatform, toKeyInput };

/**
 * Feeds remote keys to `onInput`, suspending non-`back` keys while a `TvTextInput` / `TextEntryBoundary` session is
 * active (#48). When rendered inside {@link TvRemoteProvider}, subscribes to its shared root dispatcher with zero
 * additional native/web listeners (#277); outside a provider, attaches a direct platform listener fallback.
 */
export function useTvKeySource(onInput: (k: KeyInput) => void): void {
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

    if (dispatcher !== null) {
      const unregisterTextEntry = dispatcher.registerTextEntry(textEntry);
      const unsubscribe = dispatcher.subscribe((event) =>
        forward(event.input, event.requirePriorDown),
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

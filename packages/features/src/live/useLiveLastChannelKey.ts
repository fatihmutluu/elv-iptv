import type { KeymapOverrides } from '@elv/focus-core';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { evaluateRemappedEvent, mapWebKeyToRemoteKey } from '../shared';

/** Attaches desktop web `keydown` listener for remapped `live.lastChannel` jumps outside Favorites mode. */
export function useLiveLastChannelKey(opts: {
  readonly enabled: boolean;
  readonly keymapOverrides: KeymapOverrides;
  readonly onJumpPreviousChannel: () => void;
}): void {
  const { enabled, keymapOverrides, onJumpPreviousChannel } = opts;

  useEffect(() => {
    if ((Platform.OS as string) !== 'web' || !enabled) return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          shiftKey?: boolean;
          ctrlKey?: boolean;
          altKey?: boolean;
          metaKey?: boolean;
          target?: { tagName?: string };
          preventDefault?: () => void;
        }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          shiftKey?: boolean;
          ctrlKey?: boolean;
          altKey?: boolean;
          metaKey?: boolean;
          target?: { tagName?: string };
          preventDefault?: () => void;
        }) => void,
      ) => void;
    };
    const onKeyDown = (e: {
      key?: string;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      target?: { tagName?: string };
      preventDefault?: () => void;
    }) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const tag = e.target?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!e.key) return;
      const mappedKey = mapWebKeyToRemoteKey(e.key);
      if (mappedKey === null) return;
      const evalResult = evaluateRemappedEvent(keymapOverrides, 'live', {
        key: mappedKey,
        kind: e.shiftKey ? 'long' : 'press',
      });
      if (evalResult.status === 'suppressed') return;
      if (evalResult.actionId === 'live.lastChannel') {
        e.preventDefault?.();
        onJumpPreviousChannel();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [enabled, keymapOverrides, onJumpPreviousChannel]);
}

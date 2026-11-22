import { type Key, type KeyInput, LONG_PRESS_MS } from '@elv/focus-core';
import {
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { BackHandler, Platform, TVEventControl, TVEventHandler } from 'react-native';
import { type AndroidKeySource, createAndroidKeyAdapter } from './android-keys';
import { RemoteKeysContext } from './RemoteKeysProvider';
import {
  isEventConsumed,
  type TextEntryActiveSource,
  TvRemoteContext,
  type TvRemoteDispatcher,
  type TvRemoteEvent,
} from './remote-context';
import { TextEntryContext } from './text-entry';
import { subscribeWebKeys, type WebKeyWindowLike } from './web-keys';

export { TvRemoteContext, type TvRemoteDispatcher, type TvRemoteEvent };

/** Platforms whose remote events differ: on tvOS the Menu button is Back. */
export type TvPlatform = 'ios' | 'android';

/** Optional subscriber-count lifecycle callbacks for {@link createTvRemoteDispatcher} (#277). */
export interface TvRemoteDispatcherLifecycle {
  /** Invoked when subscriber count transitions `0 -> 1`; may return a cleanup function invoked on `1 -> 0`. */
  onFirstListener?: (() => (() => void) | undefined) | (() => void);
  /** Invoked after subscriber count transitions `1 -> 0` and any `onFirstListener` cleanup runs. */
  onLastListener?: () => void;
}

/** Props of {@link TvRemoteProvider}. */
export interface TvRemoteProviderProps {
  /** Optional pre-created dispatcher (useful for testing or instrumentation). */
  dispatcher?: TvRemoteDispatcher;
  children: ReactNode;
}

const KEYS: Readonly<Record<string, Key>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  playPause: 'playPause',
  play: 'play',
  pause: 'pause',
  stop: 'stop',
  rewind: 'rewind',
  fastForward: 'fastForward',
  next: 'next',
  previous: 'previous',
  captions: 'captions',
  audioTrack: 'audioTrack',
  guide: 'guide',
  info: 'info',
  search: 'search',
  lastChannel: 'lastChannel',
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

/** Creates an isolated {@link TvRemoteDispatcher} that fans out platform key inputs to subscribers safely. */
export function createTvRemoteDispatcher(
  lifecycle?: TvRemoteDispatcherLifecycle,
): TvRemoteDispatcher {
  const listeners = new Set<(event: TvRemoteEvent) => void>();
  const interceptors: Array<(input: KeyInput) => boolean> = [];
  const textEntries = new Map<TextEntryActiveSource, number>();
  let backDownWhileTextEntryAt: number | undefined;
  let detachLifecycle: (() => void) | undefined;

  const isTextEntryActive = (): boolean => {
    for (const controller of textEntries.keys()) {
      if (controller.isActive()) return true;
    }
    return false;
  };

  const exitActiveTextEntry = (): boolean => {
    for (const controller of [...textEntries.keys()].reverse()) {
      if (controller.isActive()) {
        controller.exit?.();
        return true;
      }
    }
    return false;
  };

  const broadcast = (event: TvRemoteEvent): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(event);
      } catch {
        // Isolate throwing subscribers so sibling consumers keep receiving input.
      }
    }
  };

  return {
    subscribe(listener) {
      const wasEmpty = listeners.size === 0;
      listeners.add(listener);
      if (wasEmpty) {
        const cleanup = lifecycle?.onFirstListener?.();
        detachLifecycle = typeof cleanup === 'function' ? cleanup : undefined;
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (listeners.delete(listener) && listeners.size === 0) {
          const cleanup = detachLifecycle;
          detachLifecycle = undefined;
          cleanup?.();
          lifecycle?.onLastListener?.();
        }
      };
    },
    registerInterceptor(interceptor) {
      interceptors.push(interceptor);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const idx = interceptors.lastIndexOf(interceptor);
        if (idx >= 0) interceptors.splice(idx, 1);
      };
    },
    dispatch(input, requirePriorDown): boolean {
      for (let i = interceptors.length - 1; i >= 0; i -= 1) {
        const interceptor = interceptors[i];
        if (!interceptor) continue;
        try {
          if (interceptor(input)) return true;
        } catch {
          // Isolate throwing interceptors.
        }
      }
      if (input.key === 'back') {
        if (input.action === 'press') {
          if (exitActiveTextEntry()) return true;
        } else if (input.action === 'down') {
          backDownWhileTextEntryAt = isTextEntryActive() ? input.time : undefined;
        } else if (input.action === 'up') {
          const downAt = backDownWhileTextEntryAt;
          backDownWhileTextEntryAt = undefined;
          if (downAt !== undefined) {
            if (input.time - downAt < LONG_PRESS_MS) {
              exitActiveTextEntry();
              broadcast({
                input: { key: 'back', action: 'cancel', time: input.time },
                requirePriorDown,
              });
              return true;
            }
          } else if (!requirePriorDown && exitActiveTextEntry()) {
            broadcast({
              input: { key: 'back', action: 'cancel', time: input.time },
              requirePriorDown: false,
            });
            return true;
          }
        } else if (input.action === 'cancel') {
          backDownWhileTextEntryAt = undefined;
        }
      }
      const event: TvRemoteEvent = { input, requirePriorDown };
      broadcast(event);
      return isEventConsumed(event);
    },
    registerTextEntry(controller) {
      textEntries.set(controller, (textEntries.get(controller) ?? 0) + 1);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const next = (textEntries.get(controller) ?? 0) - 1;
        if (next <= 0) textEntries.delete(controller);
        else textEntries.set(controller, next);
      };
    },
    isTextEntryActive,
    subscriberCount: () => listeners.size,
  };
}

/** Attaches a single platform key listener (web, Android raw + BackHandler, or TVEventHandler + BackHandler). */
export function attachPlatformKeySource(options: {
  raw: AndroidKeySource | null;
  isTextEntryActive: () => boolean;
  emit: (input: KeyInput, requirePriorDown: boolean) => boolean;
}): () => void {
  const { raw, isTextEntryActive, emit } = options;

  if ((Platform.OS as string) === 'web') {
    const win = (globalThis as { window?: WebKeyWindowLike }).window;
    const offWeb =
      win && typeof win.addEventListener === 'function'
        ? subscribeWebKeys(
            win,
            { isActive: isTextEntryActive },
            () => performance.now(),
            (k) => {
              emit(k, true);
            },
          )
        : undefined;
    return () => {
      offWeb?.();
    };
  }

  if (Platform.OS === 'android' && raw) {
    const adapt = createAndroidKeyAdapter();
    let rawBackHeld = false;
    let pendingRawBackUp = false;
    let lastRawBackUpAt = 0;
    let lastRawBackConsumed = false;

    const sub = raw.addListener((event) => {
      const now = performance.now();
      if (event.action === 'blur') {
        rawBackHeld = false;
        pendingRawBackUp = false;
        lastRawBackConsumed = false;
      }
      for (const input of adapt(event, now)) {
        if (input.key === 'back') {
          if (input.action === 'down') {
            rawBackHeld = true;
            emit(input, true);
            continue;
          }
          if (input.action === 'up') {
            rawBackHeld = false;
            pendingRawBackUp = true;
            lastRawBackUpAt = now;
            lastRawBackConsumed = emit(input, true);
            continue;
          }
          if (input.action === 'cancel') {
            rawBackHeld = false;
            pendingRawBackUp = false;
            lastRawBackConsumed = false;
            emit(input, true);
            continue;
          }
        }
        emit(input, true);
      }
    });
    const consume = BackHandler?.addEventListener?.('hardwareBackPress', () => {
      const now = performance.now();
      if (rawBackHeld) return true;
      if (pendingRawBackUp && now - lastRawBackUpAt < RAW_BACK_DEDUP_MS) {
        pendingRawBackUp = false;
        return lastRawBackConsumed;
      }
      pendingRawBackUp = false;
      return emit({ key: 'back', action: 'press', time: now }, false);
    });
    return () => {
      for (const input of adapt({ action: 'blur' }, performance.now())) emit(input, true);
      sub.remove();
      consume?.remove();
    };
  }

  const releaseMenu = Platform.OS === 'ios' && Platform.isTV ? retainTvMenuKey() : undefined;
  const remote = TVEventHandler?.addListener?.((event) => {
    const input = toKeyInput(event, performance.now(), Platform.OS === 'ios' ? 'ios' : 'android');
    if (input) emit(input, false);
  });
  const back = BackHandler?.addEventListener?.('hardwareBackPress', () => {
    return emit({ key: 'back', action: 'press', time: performance.now() }, false);
  });
  return () => {
    remote?.remove();
    back?.remove();
    releaseMenu?.();
  };
}

/**
 * Mounts one root platform remote/keyboard listener and fans events out to all descendant `useTvKeySource` hooks
 * without tearing down native or DOM listeners as screens mount, unmount, or change handler identities (#277).
 * Uses lazy `0 -> 1` / `1 -> 0` attachment when managing its own dispatcher so idle providers register zero native
 * listeners.
 */
export function TvRemoteProvider({ dispatcher, children }: TvRemoteProviderProps): ReactElement {
  const parentDispatcher = useContext(TvRemoteContext);
  const raw = useContext(RemoteKeysContext);
  const parentTextEntry = useContext(TextEntryContext);
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const detachOwnRef = useRef<(() => void) | undefined>(undefined);
  const attachedRawRef = useRef<AndroidKeySource | null | undefined>(undefined);

  const detachOwn = useCallback(() => {
    detachOwnRef.current?.();
    detachOwnRef.current = undefined;
    attachedRawRef.current = undefined;
  }, []);

  const attachOwn = useCallback(
    (target: TvRemoteDispatcher) => {
      detachOwn();
      const currentRaw = rawRef.current;
      attachedRawRef.current = currentRaw;
      detachOwnRef.current = attachPlatformKeySource({
        raw: currentRaw,
        isTextEntryActive: () => target.isTextEntryActive(),
        emit: (input, requirePriorDown) => target.dispatch(input, requirePriorDown),
      });
      return detachOwn;
    },
    [detachOwn],
  );

  const ownDispatcher = useMemo(() => {
    const created: TvRemoteDispatcher = createTvRemoteDispatcher({
      onFirstListener: () => attachOwn(created),
    });
    return created;
  }, [attachOwn]);

  const activeDispatcher = dispatcher ?? ownDispatcher;
  const ownedByAncestor = parentDispatcher === activeDispatcher;

  useEffect(() => {
    if (ownedByAncestor) return;
    return activeDispatcher.registerTextEntry(parentTextEntry);
  }, [ownedByAncestor, parentTextEntry, activeDispatcher]);

  useEffect(() => {
    if (ownedByAncestor) return;
    if (dispatcher !== undefined) {
      return attachPlatformKeySource({
        raw,
        isTextEntryActive: () => activeDispatcher.isTextEntryActive(),
        emit: (input, requirePriorDown) => activeDispatcher.dispatch(input, requirePriorDown),
      });
    }
    if (activeDispatcher.subscriberCount() > 0 && attachedRawRef.current !== raw) {
      attachOwn(activeDispatcher);
    }
    return detachOwn;
  }, [ownedByAncestor, dispatcher, raw, activeDispatcher, attachOwn, detachOwn]);

  return createElement(TvRemoteContext.Provider, { value: activeDispatcher }, children);
}

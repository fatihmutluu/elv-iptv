import type { Key, KeyInput } from '@elv/focus-core';
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from 'react';
import { BackHandler, Platform, TVEventControl, TVEventHandler } from 'react-native';
import { type AndroidKeySource, createAndroidKeyAdapter } from './android-keys';
import { RemoteKeysContext } from './RemoteKeysProvider';
import { TextEntryContext, type TextEntryController } from './text-entry';
import { subscribeWebKeys, type WebKeyWindowLike } from './web-keys';

/** Platforms whose remote events differ: on tvOS the Menu button is Back. */
export type TvPlatform = 'ios' | 'android';

/** Event broadcast by {@link TvRemoteDispatcher} to every active subscriber. */
export interface TvRemoteEvent {
  readonly input: KeyInput;
  readonly requirePriorDown: boolean;
}

/** Centralized fan-out dispatcher decoupling root platform key listeners from `useTvKeySource` consumers (#277). */
export interface TvRemoteDispatcher {
  /** Subscribes to broadcasted remote key events; returns an idempotent unsubscribe function. */
  subscribe(listener: (event: TvRemoteEvent) => void): () => void;
  /** Broadcasts a remote key input to all active subscribers, isolating any thrown subscriber errors. */
  dispatch(input: KeyInput, requirePriorDown: boolean): void;
  /** Registers a `TextEntryController` so root web listeners see active child text-entry boundaries. */
  registerTextEntry(controller: TextEntryController): () => void;
  /** Reports whether any registered `TextEntryController` is currently active. */
  isTextEntryActive(): boolean;
  /** Returns the number of currently attached subscribers. */
  subscriberCount(): number;
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

/** Creates an isolated {@link TvRemoteDispatcher} that fans out platform key inputs to subscribers safely. */
export function createTvRemoteDispatcher(): TvRemoteDispatcher {
  const listeners = new Set<(event: TvRemoteEvent) => void>();
  const textEntries = new Map<TextEntryController, number>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    dispatch(input, requirePriorDown) {
      const event: TvRemoteEvent = { input, requirePriorDown };
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener(event);
        } catch {
          // Isolate throwing subscribers so sibling consumers keep receiving input.
        }
      }
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
    isTextEntryActive() {
      for (const controller of textEntries.keys()) {
        if (controller.isActive()) return true;
      }
      return false;
    },
    subscriberCount: () => listeners.size,
  };
}

/** Attaches a single platform key listener (web, Android raw + BackHandler, or TVEventHandler + BackHandler). */
export function attachPlatformKeySource(options: {
  raw: AndroidKeySource | null;
  isTextEntryActive: () => boolean;
  emit: (input: KeyInput, requirePriorDown: boolean) => void;
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
            (k) => emit(k, true),
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
        emit(input, true);
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
      emit({ key: 'back', action: 'press', time: now }, false);
      return true;
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
    emit({ key: 'back', action: 'press', time: performance.now() }, false);
    return true;
  });
  return () => {
    remote?.remove();
    back?.remove();
    releaseMenu?.();
  };
}

/** Context holding the shared {@link TvRemoteDispatcher}, or `null` when no {@link TvRemoteProvider} is mounted. */
export const TvRemoteContext = createContext<TvRemoteDispatcher | null>(null);

/**
 * Mounts one root platform remote/keyboard listener and fans events out to all descendant `useTvKeySource` hooks
 * without tearing down native or DOM listeners as screens mount, unmount, or change handler identities (#277).
 */
export function TvRemoteProvider({ dispatcher, children }: TvRemoteProviderProps): ReactElement {
  const ownDispatcher = useMemo(() => createTvRemoteDispatcher(), []);
  const activeDispatcher = dispatcher ?? ownDispatcher;
  const raw = useContext(RemoteKeysContext);
  const parentTextEntry = useContext(TextEntryContext);

  useEffect(
    () =>
      attachPlatformKeySource({
        raw,
        isTextEntryActive: () => parentTextEntry.isActive() || activeDispatcher.isTextEntryActive(),
        emit: (input, requirePriorDown) => activeDispatcher.dispatch(input, requirePriorDown),
      }),
    [raw, parentTextEntry, activeDispatcher],
  );

  return createElement(TvRemoteContext.Provider, { value: activeDispatcher }, children);
}

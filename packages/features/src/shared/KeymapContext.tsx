import {
  createKeymapStore,
  type KeymapStore,
  ok,
  type PreferencesKvBackend,
  type RawKeymapOverrides,
  type Result,
} from '@elv/domain';
import {
  collectLongPressKeys,
  type Key,
  type KeyBindingValidation,
  type KeymapOverrides,
  type KeyTrigger,
  parseKeymapOverrides,
  type RemappableActionId,
  resetAllKeyBindings,
  resetKeyBinding,
  setKeyBinding,
  validateKeyBinding,
} from '@elv/focus-core';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

function createMemoryKvBackend(): PreferencesKvBackend {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
}

/** Reactive remote key remapping state & actions exposed by {@link useKeymap} (`#33`). */
export interface KeymapContextValue {
  readonly overrides: KeymapOverrides;
  readonly longPressKeys: readonly Key[];
  readonly ready: boolean;
  rebindAction(
    actionId: RemappableActionId,
    trigger: KeyTrigger,
  ): Promise<{ readonly validation: KeyBindingValidation; readonly saved: boolean }>;
  clearAction(actionId: RemappableActionId): Promise<Result<void>>;
  resetAction(actionId: RemappableActionId): Promise<Result<void>>;
  resetAll(): Promise<Result<void>>;
}

const DEFAULT_LONG_PRESS_KEYS = collectLongPressKeys({});

const DEFAULT_KEYMAP_CONTEXT: KeymapContextValue = {
  overrides: {},
  longPressKeys: DEFAULT_LONG_PRESS_KEYS,
  ready: true,
  rebindAction: async (actionId, trigger) => ({
    validation: validateKeyBinding(actionId, trigger),
    saved: false,
  }),
  clearAction: async () => ok(undefined),
  resetAction: async () => ok(undefined),
  resetAll: async () => ok(undefined),
};

const KeymapContext = createContext<KeymapContextValue>(DEFAULT_KEYMAP_CONTEXT);

/** Props of {@link KeymapProvider}. */
export interface KeymapProviderProps {
  /** Optional persistent sparse keymap store (`#33`); falls back to an in-memory store. */
  readonly keymapStore?: KeymapStore;
  /** Active viewer profile ID; switching profiles hydrates that profile's overrides. */
  readonly activeProfileId?: string;
  readonly children: ReactNode;
}

/**
 * Hydrates and persists per-profile sparse remote key overrides (`#33`), exposing validated
 * `overrides`, dynamic `longPressKeys` for `useKeyInterpreter`, and rebind/clear/reset actions.
 */
export function KeymapProvider({
  keymapStore,
  activeProfileId = 'default',
  children,
}: KeymapProviderProps): ReactElement {
  const initialProfileRef = useRef(activeProfileId);
  const fallbackStore = useMemo(
    () =>
      createKeymapStore(createMemoryKvBackend(), { initialProfileId: initialProfileRef.current }),
    [],
  );
  const store = keymapStore ?? fallbackStore;

  const [overrides, setOverrides] = useState<KeymapOverrides>(() =>
    parseKeymapOverrides(store.getSnapshot().overrides),
  );
  const [ready, setReady] = useState(false);

  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const loadedProfileRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    loadedProfileRef.current = null;

    const unsubscribe = store.subscribe((snapshot) => {
      if (!cancelled) {
        const parsed = parseKeymapOverrides(snapshot.overrides);
        overridesRef.current = parsed;
        setOverrides(parsed);
        setReady(true);
      }
    });

    void store
      .load()
      .then((snapshot) => {
        if (!cancelled) {
          loadedProfileRef.current = snapshot.profileId;
          const parsed = parseKeymapOverrides(snapshot.overrides);
          overridesRef.current = parsed;
          setOverrides(parsed);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);

  useEffect(() => {
    const normalized = activeProfileId.trim() || 'default';
    if (loadedProfileRef.current === normalized && store.getSnapshot().profileId === normalized) {
      return;
    }
    loadedProfileRef.current = normalized;
    void store.switchProfile(normalized).catch(() => undefined);
  }, [activeProfileId, store]);

  const persistOverrides = useCallback(
    async (next: KeymapOverrides): Promise<Result<void>> => {
      overridesRef.current = next;
      setOverrides(next);
      const res = await store.setOverrides(next as RawKeymapOverrides);
      return res.ok ? ok(undefined) : res;
    },
    [store],
  );

  const rebindAction = useCallback(
    async (
      actionId: RemappableActionId,
      trigger: KeyTrigger,
    ): Promise<{ readonly validation: KeyBindingValidation; readonly saved: boolean }> => {
      const validation = validateKeyBinding(actionId, trigger);
      if (!validation.ok) return { validation, saved: false };
      const next = setKeyBinding(overridesRef.current, actionId, trigger);
      const res = await persistOverrides(next);
      return { validation, saved: res.ok };
    },
    [persistOverrides],
  );

  const clearAction = useCallback(
    async (actionId: RemappableActionId): Promise<Result<void>> => {
      const next = setKeyBinding(overridesRef.current, actionId, null);
      return persistOverrides(next);
    },
    [persistOverrides],
  );

  const resetAction = useCallback(
    async (actionId: RemappableActionId): Promise<Result<void>> => {
      const next = resetKeyBinding(overridesRef.current, actionId);
      return persistOverrides(next);
    },
    [persistOverrides],
  );

  const resetAll = useCallback(async (): Promise<Result<void>> => {
    const empty = resetAllKeyBindings();
    overridesRef.current = empty;
    setOverrides(empty);
    const res = await store.reset();
    return res.ok ? ok(undefined) : res;
  }, [store]);

  const longPressKeys = useMemo(() => collectLongPressKeys(overrides), [overrides]);

  const value = useMemo<KeymapContextValue>(
    () => ({
      overrides,
      longPressKeys,
      ready,
      rebindAction,
      clearAction,
      resetAction,
      resetAll,
    }),
    [clearAction, longPressKeys, overrides, ready, rebindAction, resetAction, resetAll],
  );

  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

/** Reads and mutates the active profile's remote keymap overrides (`#33`). */
export function useKeymap(): KeymapContextValue {
  return useContext(KeymapContext);
}

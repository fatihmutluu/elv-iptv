import {
  type ConnectionTracker,
  createIdleProbeController,
  createStreamHealthCache,
  createStreamHealthScorer,
  type IdleProbeController,
  type StreamHealthCache,
  type StreamHealthScorer,
  type StreamHealthStatus,
} from '@elv/playback';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

/** Session-scoped stream health cache, decayed scorer, idle probe controller, and alternate connection guard (`#157`, `#167`, `#195`). */
export interface StreamHealthContextValue {
  readonly healthCache: StreamHealthCache;
  readonly healthScorer: StreamHealthScorer;
  readonly idleProbeController: IdleProbeController;
  readonly canAcquireAlternate: (accountKey: string, maxConnections: number) => boolean;
  readonly registerConnectionTracker: (tracker: ConnectionTracker) => () => void;
}

/** Props of {@link StreamHealthProvider}. */
export interface StreamHealthProviderProps {
  readonly healthCache?: StreamHealthCache;
  readonly healthScorer?: StreamHealthScorer;
  readonly idleProbeController?: IdleProbeController;
  readonly canAcquireAlternate?: (accountKey: string, maxConnections: number) => boolean;
  readonly connectionTracker?: ConnectionTracker;
  readonly children: ReactNode;
}

const StreamHealthContext = createContext<StreamHealthContextValue | null>(null);

const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;

function createFallbackStreamHealth(): StreamHealthContextValue {
  return {
    healthCache: createStreamHealthCache(),
    healthScorer: createStreamHealthScorer(),
    idleProbeController: createIdleProbeController(),
    canAcquireAlternate: () => true,
    registerConnectionTracker: () => () => undefined,
  };
}

/**
 * Provides session-scoped passive stream health caching (`#167`), exponentially decayed failover
 * scoring (`#195`), idle probe cancellation (`#167`), and connection-safe alternate gating (`#157`).
 */
export function StreamHealthProvider({
  healthCache: healthCacheProp,
  healthScorer: healthScorerProp,
  idleProbeController: idleProbeControllerProp,
  canAcquireAlternate: canAcquireAlternateProp,
  connectionTracker,
  children,
}: StreamHealthProviderProps): ReactElement {
  const defaultCache = useMemo(() => createStreamHealthCache(), []);
  const defaultScorer = useMemo(() => createStreamHealthScorer(), []);
  const defaultProbeController = useMemo(() => createIdleProbeController(), []);

  const healthCache = healthCacheProp ?? defaultCache;
  const healthScorer = healthScorerProp ?? defaultScorer;
  const idleProbeController = idleProbeControllerProp ?? defaultProbeController;

  const trackersRef = useRef<Set<ConnectionTracker>>(new Set());
  const customCanAcquireRef = useRef(canAcquireAlternateProp);
  customCanAcquireRef.current = canAcquireAlternateProp;
  const propTrackerRef = useRef(connectionTracker);
  propTrackerRef.current = connectionTracker;

  const registerConnectionTracker = useCallback((tracker: ConnectionTracker): (() => void) => {
    trackersRef.current.add(tracker);
    return () => {
      trackersRef.current.delete(tracker);
    };
  }, []);

  const canAcquireAlternate = useCallback((accountKey: string, maxConnections: number): boolean => {
    const customCheck = customCanAcquireRef.current;
    if (customCheck !== undefined && !customCheck(accountKey, maxConnections)) {
      return false;
    }
    const propTracker = propTrackerRef.current;
    if (propTracker?.checkLimit({ accountKey, maxConnections }).exceeds) {
      return false;
    }
    for (const tracker of trackersRef.current) {
      if (tracker.checkLimit({ accountKey, maxConnections }).exceeds) {
        return false;
      }
    }
    return true;
  }, []);

  const value = useMemo<StreamHealthContextValue>(
    () => ({
      healthCache,
      healthScorer,
      idleProbeController,
      canAcquireAlternate,
      registerConnectionTracker,
    }),
    [
      canAcquireAlternate,
      healthCache,
      healthScorer,
      idleProbeController,
      registerConnectionTracker,
    ],
  );

  return <StreamHealthContext.Provider value={value}>{children}</StreamHealthContext.Provider>;
}

/**
 * Reads the nearest {@link StreamHealthProvider} context, falling back to isolated in-memory
 * defaults when a screen is rendered standalone outside `AppProviders`.
 */
export function useStreamHealth(): StreamHealthContextValue {
  const ctx = useContext(StreamHealthContext);
  const fallback = useMemo(() => (ctx !== null ? null : createFallbackStreamHealth()), [ctx]);
  return ctx ?? (fallback as StreamHealthContextValue);
}

/**
 * Reactively subscribes to the cached passive health status of a single live channel key (`#167`).
 * Returns `undefined` when unmounted from `StreamHealthProvider` or when no status is cached.
 */
export function useChannelHealthStatus(
  channelKey: string | undefined,
): StreamHealthStatus | undefined {
  const ctx = useContext(StreamHealthContext);
  const cache = ctx?.healthCache;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      cache !== undefined && channelKey !== undefined
        ? cache.subscribe(onStoreChange)
        : () => undefined,
    [cache, channelKey],
  );
  const getSnapshot = useCallback((): StreamHealthStatus | undefined => {
    if (cache === undefined || channelKey === undefined) return undefined;
    return cache.get(channelKey)?.status;
  }, [cache, channelKey]);

  return useSyncExternalStore(
    cache !== undefined && channelKey !== undefined ? subscribe : NOOP_SUBSCRIBE,
    getSnapshot,
    getSnapshot,
  );
}

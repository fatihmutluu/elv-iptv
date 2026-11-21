import {
  createContext,
  createElement,
  type DependencyList,
  type EffectCallback,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

const RouteActiveContext = createContext<boolean>(true);

/** Props of {@link RouteActiveProvider}. */
export interface RouteActiveProviderProps {
  /** Whether the wrapped route subtree is currently active and foregrounded. */
  readonly active: boolean;
  readonly children?: ReactNode;
}

/**
 * Propagates foreground route activity down a screen subtree so offscreen or backgrounded browse
 * screens can freeze subscriptions and timers cleanly while fullscreen playback stays responsive
 * (#166). Nested providers remain inactive whenever an ancestor route is inactive.
 */
export function RouteActiveProvider({ active, children }: RouteActiveProviderProps): ReactElement {
  const parentActive = useContext(RouteActiveContext);
  return createElement(RouteActiveContext.Provider, { value: parentActive && active }, children);
}

/** Returns whether the current route subtree is active (defaults to `true` outside a provider). */
export function useRouteActive(): boolean {
  return useContext(RouteActiveContext);
}

/**
 * Runs `effect` only while the enclosing route is active, automatically running its cleanup when
 * the route becomes inactive and resuming with the latest `deps` once active again (#166).
 */
export function useActiveEffect(effect: EffectCallback, deps: DependencyList): void {
  const active = useRouteActive();
  // biome-ignore lint/correctness/useExhaustiveDependencies: caller supplies explicit deps; active gates execution and teardown
  useEffect(() => {
    if (!active) return;
    return effect();
  }, [active, ...deps]);
}

interface VisibilityDocumentLike {
  readonly visibilityState?: string;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

function getVisibilityDocument(): VisibilityDocumentLike | undefined {
  return (globalThis as { document?: VisibilityDocumentLike }).document;
}

function readDocumentVisible(doc: VisibilityDocumentLike | undefined): boolean {
  return doc?.visibilityState !== 'hidden';
}

/**
 * Tracks web document visibility (`document.visibilityState !== 'hidden'`) via `'visibilitychange'`,
 * defaulting to `true` on platforms without a DOM `document` (#166).
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    readDocumentVisible(getVisibilityDocument()),
  );

  useEffect(() => {
    const doc = getVisibilityDocument();
    if (!doc?.addEventListener || !doc.removeEventListener) return;
    const onVisibilityChange = (): void => {
      setVisible(readDocumentVisible(doc));
    };
    onVisibilityChange();
    doc.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      doc.removeEventListener?.('visibilitychange', onVisibilityChange);
    };
  }, []);

  return visible;
}

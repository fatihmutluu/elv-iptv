import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  RouteActiveProvider,
  useActiveEffect,
  useDocumentVisible,
  useRouteActive,
} from './useRouteActive';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function DocumentVisibleProbe({ onValue }: { readonly onValue: (value: boolean) => void }) {
  onValue(useDocumentVisible());
  return null;
}

function ActiveProbe({ onValue }: { readonly onValue: (value: boolean) => void }) {
  onValue(useRouteActive());
  return null;
}

function NestedProbe({
  onOuter,
  onInner,
}: {
  readonly onOuter: (value: boolean) => void;
  readonly onInner: (value: boolean) => void;
}) {
  onOuter(useRouteActive());
  return createElement(
    RouteActiveProvider,
    { active: true },
    createElement(ActiveProbe, { onValue: onInner }),
  );
}

function EffectWatcher({
  token,
  onStart,
  onCleanup,
}: {
  readonly token: number;
  readonly onStart: (token: number) => void;
  readonly onCleanup: (token: number) => void;
}) {
  useActiveEffect(() => {
    onStart(token);
    return () => {
      onCleanup(token);
    };
  }, [token]);
  return null;
}

describe('useRouteActive & RouteActiveProvider', () => {
  it('defaults to true outside any RouteActiveProvider', () => {
    let observed: boolean | undefined;
    const root = createRoot();
    act(() => {
      root.render(
        createElement(ActiveProbe, {
          onValue: (v) => {
            observed = v;
          },
        }),
      );
    });
    expect(observed).toBe(true);
    act(() => {
      root.unmount();
    });
  });

  it('propagates active state and keeps nested providers frozen when an ancestor is inactive', () => {
    let outerObserved: boolean | undefined;
    let innerObserved: boolean | undefined;
    const onOuter = (v: boolean) => {
      outerObserved = v;
    };
    const onInner = (v: boolean) => {
      innerObserved = v;
    };

    const root = createRoot();
    act(() => {
      root.render(
        createElement(
          RouteActiveProvider,
          { active: true },
          createElement(NestedProbe, { onOuter, onInner }),
        ),
      );
    });
    expect(outerObserved).toBe(true);
    expect(innerObserved).toBe(true);

    act(() => {
      root.render(
        createElement(
          RouteActiveProvider,
          { active: false },
          createElement(NestedProbe, { onOuter, onInner }),
        ),
      );
    });
    expect(outerObserved).toBe(false);
    expect(innerObserved).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('runs, cleans up, skips while inactive, and resumes useActiveEffect cleanly', () => {
    const starts: number[] = [];
    const cleanups: number[] = [];
    const cleanupSpy = vi.fn();
    const onStart = (t: number) => {
      starts.push(t);
    };
    const onCleanup = (t: number) => {
      cleanups.push(t);
      cleanupSpy(t);
    };

    const root = createRoot();
    act(() => {
      root.render(
        createElement(
          RouteActiveProvider,
          { active: true },
          createElement(EffectWatcher, { token: 1, onStart, onCleanup }),
        ),
      );
    });
    expect(starts).toEqual([1]);
    expect(cleanups).toEqual([]);

    // Freeze route -> cleanup runs immediately
    act(() => {
      root.render(
        createElement(
          RouteActiveProvider,
          { active: false },
          createElement(EffectWatcher, { token: 1, onStart, onCleanup }),
        ),
      );
    });
    expect(starts).toEqual([1]);
    expect(cleanups).toEqual([1]);

    // Deps change while frozen -> effect is skipped
    act(() => {
      root.render(
        createElement(
          RouteActiveProvider,
          { active: false },
          createElement(EffectWatcher, { token: 2, onStart, onCleanup }),
        ),
      );
    });
    expect(starts).toEqual([1]);
    expect(cleanups).toEqual([1]);

    // Unfreeze route -> effect re-runs with latest dep (2)
    act(() => {
      root.render(
        createElement(
          RouteActiveProvider,
          { active: true },
          createElement(EffectWatcher, { token: 2, onStart, onCleanup }),
        ),
      );
    });
    expect(starts).toEqual([1, 2]);
    expect(cleanups).toEqual([1]);

    // Unmount cleans up active effect
    act(() => {
      root.unmount();
    });
    expect(cleanups).toEqual([1, 2]);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });
});

describe('useDocumentVisible', () => {
  it('defaults to true when document is unavailable and tracks visibilitychange when present', () => {
    const g = globalThis as { document?: unknown };
    const origDoc = g.document;
    try {
      g.document = undefined;
      let observed: boolean | undefined;
      const rootA = createRoot();
      act(() => {
        rootA.render(
          createElement(DocumentVisibleProbe, {
            onValue: (v) => {
              observed = v;
            },
          }),
        );
      });
      expect(observed).toBe(true);
      act(() => {
        rootA.unmount();
      });

      const listeners = new Set<() => void>();
      const fakeDoc = {
        visibilityState: 'visible',
        addEventListener: vi.fn((type: string, fn: () => void) => {
          if (type === 'visibilitychange') listeners.add(fn);
        }),
        removeEventListener: vi.fn((type: string, fn: () => void) => {
          if (type === 'visibilitychange') listeners.delete(fn);
        }),
      };
      g.document = fakeDoc;

      const rootB = createRoot();
      act(() => {
        rootB.render(
          createElement(DocumentVisibleProbe, {
            onValue: (v) => {
              observed = v;
            },
          }),
        );
      });
      expect(observed).toBe(true);
      expect(listeners.size).toBe(1);

      act(() => {
        fakeDoc.visibilityState = 'hidden';
        for (const fn of listeners) fn();
      });
      expect(observed).toBe(false);

      act(() => {
        fakeDoc.visibilityState = 'visible';
        for (const fn of listeners) fn();
      });
      expect(observed).toBe(true);

      act(() => {
        rootB.unmount();
      });
      expect(listeners.size).toBe(0);
    } finally {
      g.document = origDoc;
    }
  });
});

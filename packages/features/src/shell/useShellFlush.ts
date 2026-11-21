import type { CatalogService } from '@elv/data';
import { useEffect, useRef } from 'react';
import type { AppLifecyclePort } from '../ports/app-lifecycle';

/** Options for {@link useShellFlush}. */
export interface UseShellFlushOptions {
  readonly catalog: CatalogService;
  readonly appLifecycle?: AppLifecyclePort;
  readonly flushPreferences?: () => Promise<void>;
  readonly onForegroundChange?: (active: boolean) => void;
}

/**
 * Coordinates foreground tracking and guaranteed coalesced write flushing (`catalog.flushPendingWrites`
 * and `preferencesStore.flush`) on mobile/TV backgrounding, desktop window unload/pagehide, and
 * shell unmount (`#230`).
 */
export function useShellFlush({
  catalog,
  appLifecycle,
  flushPreferences,
  onForegroundChange,
}: UseShellFlushOptions): void {
  const refs = useRef({ catalog, flushPreferences, onForegroundChange });
  refs.current = { catalog, flushPreferences, onForegroundChange };

  useEffect(() => {
    const flushAll = () => {
      void Promise.resolve()
        .then(() => refs.current.catalog.flushPendingWrites?.())
        .catch(() => undefined);
      void Promise.resolve()
        .then(() => refs.current.flushPreferences?.())
        .catch(() => undefined);
    };

    const unsubLifecycle = appLifecycle?.subscribe((state) => {
      refs.current.onForegroundChange?.(state === 'active');
      if (state === 'background') flushAll();
    });
    if (!appLifecycle) {
      refs.current.onForegroundChange?.(true);
    }

    const winCandidate = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, listener: () => void) => void;
          removeEventListener?: (type: string, listener: () => void) => void;
        };
      }
    ).window;
    const win =
      winCandidate !== undefined &&
      typeof winCandidate.addEventListener === 'function' &&
      typeof winCandidate.removeEventListener === 'function'
        ? winCandidate
        : undefined;
    if (win) {
      win.addEventListener?.('beforeunload', flushAll);
      win.addEventListener?.('pagehide', flushAll);
    }

    return () => {
      unsubLifecycle?.();
      if (win) {
        win.removeEventListener?.('beforeunload', flushAll);
        win.removeEventListener?.('pagehide', flushAll);
      }
      flushAll();
    };
  }, [appLifecycle]);
}

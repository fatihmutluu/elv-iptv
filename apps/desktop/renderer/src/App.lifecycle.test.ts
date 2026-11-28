import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as { window?: unknown };
  if (!g.window) {
    g.window = { location: { search: '' } };
  }
});

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  StyleSheet: { create: <T>(s: T): T => s },
}));

vi.mock('@elv/features', () => ({
  AppProviders: 'AppProviders',
  AppShell: 'AppShell',
  createLazyCatalog: () => ({}),
}));

vi.mock('@elv/ui-kit', () => ({
  UiAdaptersProvider: 'UiAdaptersProvider',
}));

vi.mock('./CatalogCrashBanner.tsx', () => ({
  attemptCatalogReconnect: vi.fn(async () => true),
  CatalogCrashBanner: 'CatalogCrashBanner',
  subscribeCatalogDisconnected: vi.fn(() => () => undefined),
}));

vi.mock('./gate/GateScreen.tsx', () => ({
  GateScreen: 'GateScreen',
}));

vi.mock('./player/desktop-video-host.tsx', () => ({
  createDesktopVideoHost: () => ({ open: vi.fn(async () => null) }),
}));

vi.mock('./popout/PopoutApp.tsx', () => ({
  PopoutApp: 'PopoutApp',
}));

vi.mock('./ui/desktop-adapters.tsx', () => ({
  attachDeadHostOnlineReset: () => () => undefined,
  createDesktopUiAdapters: () => ({}),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) => [
      typeof initial === 'function' ? (initial as () => T)() : initial,
      vi.fn(),
    ],
    useRef: <T>(initial: T) => ({ current: initial }),
    useMemo: <T>(factory: () => T) => factory(),
    useCallback: <T>(fn: T) => fn,
    useEffect: () => undefined,
  };
});

import { App, createDesktopAppLifecyclePort } from './App.tsx';

function findByType(node: unknown, typeName: string): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, typeName);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === typeName) return el;
  return findByType(el.props?.children, typeName);
}

describe('Desktop App appLifecycle wiring (Wave Q5-A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits background/active from tray hide/restore and document visibilitychange, deduplicates identical states, and unsubscribes cleanly', () => {
    let onHiddenToTray: (() => void) | undefined;
    let onWindowRestored: (() => void) | undefined;
    const offHidden = vi.fn();
    const offRestored = vi.fn();
    const windowBridge = {
      onHiddenToTray: vi.fn((cb: () => void) => {
        onHiddenToTray = cb;
        return offHidden;
      }),
      onWindowRestored: vi.fn((cb: () => void) => {
        onWindowRestored = cb;
        return offRestored;
      }),
    };

    let visibilityState: 'visible' | 'hidden' = 'visible';
    const docListeners = new Set<() => void>();
    const fakeDoc = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: vi.fn((type: string, fn: () => void) => {
        if (type === 'visibilitychange') docListeners.add(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: () => void) => {
        if (type === 'visibilitychange') docListeners.delete(fn);
      }),
    };

    const events: string[] = [];
    const lifecycle = createDesktopAppLifecyclePort(windowBridge, fakeDoc);
    const unsub = lifecycle.subscribe((state) => events.push(state));

    // Minimize triggers visibilitychange -> 'background'
    visibilityState = 'hidden';
    for (const fn of docListeners) fn();
    expect(events).toEqual(['background']);

    // Duplicate hidden-to-tray while already backgrounded is deduplicated
    onHiddenToTray?.();
    expect(events).toEqual(['background']);

    // Restoring from tray emits 'active'
    onWindowRestored?.();
    expect(events).toEqual(['background', 'active']);

    // Duplicate visibilitychange -> visible while already active is deduplicated
    visibilityState = 'visible';
    for (const fn of docListeners) fn();
    expect(events).toEqual(['background', 'active']);

    // Hiding directly to tray emits 'background' even if visibilityState is still 'visible'
    onHiddenToTray?.();
    expect(events).toEqual(['background', 'active', 'background']);

    // Unsubscribe detaches all listeners
    unsub();
    expect(offHidden).toHaveBeenCalledTimes(1);
    expect(offRestored).toHaveBeenCalledTimes(1);
    expect(fakeDoc.removeEventListener).toHaveBeenCalledTimes(1);
    expect(docListeners.size).toBe(0);
  });

  it('works cleanly when windowBridge is undefined and passes appLifecycle into AppShell from App', () => {
    let visibilityState: 'visible' | 'hidden' = 'visible';
    const docListeners = new Set<() => void>();
    const fakeDoc = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type: string, fn: () => void) => docListeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => docListeners.delete(fn),
    };

    const events: string[] = [];
    const lifecycle = createDesktopAppLifecyclePort(undefined, fakeDoc);
    const unsub = lifecycle.subscribe((state) => events.push(state));

    visibilityState = 'hidden';
    for (const fn of docListeners) fn();
    visibilityState = 'visible';
    for (const fn of docListeners) fn();

    expect(events).toEqual(['background', 'active']);
    unsub();
    expect(docListeners.size).toBe(0);

    // Render App -> AppRoot -> AppShell and assert appLifecycle prop is wired
    const appEl = App() as ReactElement<Record<string, unknown>>;
    const rootTree =
      typeof appEl.type === 'function'
        ? (appEl.type as (p: Record<string, unknown>) => ReactElement<Record<string, unknown>>)(
            appEl.props,
          )
        : appEl;
    const shell = findByType(rootTree, 'AppShell');
    expect(shell).not.toBeNull();
    expect(typeof (shell?.props.appLifecycle as { subscribe?: unknown })?.subscribe).toBe(
      'function',
    );
  });
});

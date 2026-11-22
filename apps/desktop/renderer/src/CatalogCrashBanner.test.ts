import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'tr',
  preset: 'obsidianCrimson' as 'obsidianCrimson' | 'highContrast',
}));

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Platform: {
    OS: 'web',
    isTV: false,
    select: (map: Record<string, unknown>) => map.web ?? map.default,
  },
  StyleSheet: {
    create: <T>(styles: T): T => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
  },
}));

vi.mock('@elv/ui-kit', async () => {
  const { buildTheme } = await import('../../../../packages/ui-kit/src/theme/tokens.ts');
  return {
    useTheme: () => buildTheme({ preset: state.preset }),
    useI18n: () => createAppI18n(state.locale),
  };
});

import {
  attemptCatalogReconnect,
  CatalogCrashBanner,
  subscribeCatalogDisconnected,
} from './CatalogCrashBanner.tsx';

function findByTestId(node: unknown, testID: string): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTestId(child, testID);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props?.testID === testID) return el;
  return findByTestId(el.props?.children, testID);
}

function collectText(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const el = node as ReactElement<Record<string, unknown>>;
  return collectText(el.props?.children);
}

describe('CatalogCrashBanner (#435)', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.preset = 'obsidianCrimson';
  });

  it('renders localized Cinema Quietude alert bar and triggers onRetry on button press', () => {
    const onRetry = vi.fn();
    const tree = CatalogCrashBanner({ reconnecting: false, onRetry });

    const banner = findByTestId(tree, 'catalog-crash-banner');
    if (!banner) throw new Error('expected catalog-crash-banner');
    const bannerProps = banner.props as Record<string, unknown>;
    expect(bannerProps.accessibilityRole).toBe('alert');

    const retryBtn = findByTestId(tree, 'catalog-crash-retry');
    if (!retryBtn) throw new Error('expected catalog-crash-retry');
    const retryProps = retryBtn.props as Record<string, unknown>;
    expect(retryProps.disabled).toBe(false);
    expect(retryProps.accessibilityRole).toBe('button');
    expect(retryProps.accessibilityState).toEqual({ disabled: false, busy: false });
    const styleFn = retryProps.style as (s: { pressed: boolean }) => unknown[];
    expect(styleFn({ pressed: false })[1]).toMatchObject({ opacity: 1 });
    expect(styleFn({ pressed: true })[1]).toMatchObject({ opacity: 0.86 });

    expect(collectText(tree)).toEqual(['Catalog service stopped unexpectedly', 'Reconnect']);

    (retryProps.onPress as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows disabled reconnecting state and localizes cleanly into Turkish and High Contrast AAA', () => {
    state.locale = 'tr';
    state.preset = 'highContrast';
    const tree = CatalogCrashBanner({ reconnecting: true, onRetry: vi.fn() });

    const retryBtn = findByTestId(tree, 'catalog-crash-retry');
    const retryProps = retryBtn?.props as Record<string, unknown>;
    expect(retryProps.disabled).toBe(true);
    expect(retryProps.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(collectText(tree)).toEqual([
      'Katalog servisi beklenmedik şekilde durdu',
      'Yeniden bağlanıyor…',
    ]);
  });

  it('subscribeCatalogDisconnected guards missing bridge/method and forwards disconnect + cleanup', () => {
    const onDisconnect = vi.fn();
    expect(subscribeCatalogDisconnected(undefined, onDisconnect)).toBeUndefined();
    expect(subscribeCatalogDisconnected({}, onDisconnect)).toBeUndefined();

    const listeners = new Set<(msg: { reason: 'worker-exited' }) => void>();
    const unsub = vi.fn(() => {
      listeners.clear();
    });
    const dispose = subscribeCatalogDisconnected(
      {
        onDisconnected: (cb) => {
          listeners.add(cb);
          return unsub;
        },
      },
      onDisconnect,
    );

    for (const cb of listeners) cb({ reason: 'worker-exited' });
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    dispose?.();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('attemptCatalogReconnect returns true only when bridge.open() returns ok and false on error/rejection', async () => {
    expect(await attemptCatalogReconnect(undefined)).toBe(false);
    expect(await attemptCatalogReconnect({ open: async () => ok(undefined) })).toBe(true);
    expect(
      await attemptCatalogReconnect({
        open: async () => err(elvError('storage', 'worker-crashed')),
      }),
    ).toBe(false);
    expect(
      await attemptCatalogReconnect({
        open: async () => {
          throw new Error('ipc failed');
        },
      }),
    ).toBe(false);
  });
});

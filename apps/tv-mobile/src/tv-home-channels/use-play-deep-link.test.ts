import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getInitialURL: vi.fn<() => Promise<string | null>>(),
  urlListeners: new Set<(event: { url: string }) => void>(),
  addEventListener: vi.fn(),
}));

vi.mock('react-native', () => ({
  Linking: {
    getInitialURL: () => mocks.getInitialURL(),
    addEventListener: (type: 'url', listener: (event: { url: string }) => void) =>
      mocks.addEventListener(type, listener),
  },
  Platform: {
    OS: 'android',
    isTV: true,
    select: <T>(spec: Record<string, T>) => spec.android ?? spec.default,
  },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles,
    flatten: <T>(style: T) => style,
    hairlineWidth: 1,
    absoluteFill: {},
    absoluteFillObject: {},
  },
  Dimensions: {
    get: () => ({ width: 1920, height: 1080, scale: 1, fontScale: 1 }),
    addEventListener: () => ({ remove: () => {} }),
  },
  PixelRatio: {
    get: () => 1,
    getFontScale: () => 1,
    roundToNearestPixel: (n: number) => n,
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => {} }),
  },
  Animated: {
    Value: class {},
    timing: () => ({ start: () => {}, stop: () => {} }),
    View: 'Animated.View',
  },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Image: 'Image',
  ScrollView: 'ScrollView',
  FlatList: 'FlatList',
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  TVEventHandler: class {},
  findNodeHandle: () => null,
}));

import { type PlayDeepLinkState, usePlayDeepLink } from './use-play-deep-link';

beforeEach(() => {
  mocks.getInitialURL.mockReset().mockResolvedValue(null);
  mocks.urlListeners.clear();
  mocks.addEventListener
    .mockReset()
    .mockImplementation((_type: 'url', listener: (event: { url: string }) => void) => {
      mocks.urlListeners.add(listener);
      return {
        remove: () => {
          mocks.urlListeners.delete(listener);
        },
      };
    });
});

function mountHook(): {
  readonly current: () => PlayDeepLinkState;
  readonly unmount: () => Promise<void>;
} {
  let latest: PlayDeepLinkState | undefined;
  function Harness() {
    latest = usePlayDeepLink();
    return null;
  }
  const root = createRoot();
  act(() => {
    root.render(createElement(Harness));
  });
  return {
    current: () => {
      if (latest === undefined) throw new Error('Hook did not render');
      return latest;
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe('usePlayDeepLink', () => {
  it('parses a valid initial elviptv://play URL and clears it via clearPendingDeepLink', async () => {
    mocks.getInitialURL.mockResolvedValue('elviptv://play?key=live%3A1001&kind=live');

    const hook = mountHook();
    await act(async () => {
      await Promise.resolve();
    });

    expect(hook.current().pendingDeepLink).toEqual({
      itemKey: 'live:1001',
      kind: 'live',
    });

    const clearRefBefore = hook.current().clearPendingDeepLink;
    await act(async () => {
      hook.current().clearPendingDeepLink();
    });
    expect(hook.current().pendingDeepLink).toBeNull();
    expect(hook.current().clearPendingDeepLink).toBe(clearRefBefore);

    await hook.unmount();
    expect(mocks.urlListeners.size).toBe(0);
  });

  it('ignores non-play URLs (gate links, external URLs, empty keys) and initial URL rejections', async () => {
    mocks.getInitialURL.mockResolvedValue('elviptv://gate/list?items=50');
    const hook = mountHook();
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.current().pendingDeepLink).toBeNull();

    await act(async () => {
      for (const listener of [...mocks.urlListeners]) {
        listener({ url: 'https://example.test/play?key=abc' });
        listener({ url: 'elviptv://play?key=' });
        listener({ url: 'elviptv://gate/player?zaps=2' });
        listener({ url: 'elviptv://external-return' });
        listener({ url: 'elviptv://external-return?status=ok' });
      }
    });
    expect(hook.current().pendingDeepLink).toBeNull();
    await hook.unmount();

    mocks.getInitialURL.mockRejectedValueOnce(new Error('Linking unavailable'));
    const rejectedHook = mountHook();
    await act(async () => {
      await Promise.resolve();
    });
    expect(rejectedHook.current().pendingDeepLink).toBeNull();
    await rejectedHook.unmount();
  });

  it('receives runtime url events and never lets a slow initial URL overwrite a newer runtime event', async () => {
    let resolveInitial: ((url: string | null) => void) | undefined;
    mocks.getInitialURL.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveInitial = resolve;
        }),
    );

    const hook = mountHook();
    await act(async () => {
      for (const listener of [...mocks.urlListeners]) {
        listener({ url: 'elviptv://play?key=movie%3A99&kind=movie' });
      }
    });
    expect(hook.current().pendingDeepLink).toEqual({ itemKey: 'movie:99', kind: 'movie' });

    await act(async () => {
      resolveInitial?.('elviptv://play?key=stale%3A1&kind=live');
      await Promise.resolve();
    });
    expect(hook.current().pendingDeepLink).toEqual({ itemKey: 'movie:99', kind: 'movie' });

    await act(async () => {
      for (const listener of [...mocks.urlListeners]) {
        listener({ url: 'elviptv://play?key=ep%3A42&kind=episode' });
      }
    });
    expect(hook.current().pendingDeepLink).toEqual({ itemKey: 'ep:42', kind: 'episode' });

    await hook.unmount();
  });

  it('ignores late initial URL resolution after unmount and removes the Linking listener', async () => {
    let resolveInitial: ((url: string | null) => void) | undefined;
    mocks.getInitialURL.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveInitial = resolve;
        }),
    );

    const hook = mountHook();
    expect(mocks.urlListeners.size).toBe(1);
    await hook.unmount();
    expect(mocks.urlListeners.size).toBe(0);

    await act(async () => {
      resolveInitial?.('elviptv://play?key=late%3A1&kind=live');
      await Promise.resolve();
    });
    expect(hook.current().pendingDeepLink).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Image: 'Image',
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  VirtualizedList: 'VirtualizedList',
  Animated: { Value: class {}, View: 'AnimatedView' },
  Platform: {
    OS: 'web',
    isTV: false,
    select: (map: Record<string, unknown>) => map.web ?? map.default,
  },
  StyleSheet: {
    create: <T>(styles: T): T => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  Dimensions: {
    get: () => ({ width: 1280, height: 720, scale: 1, fontScale: 1 }),
    addEventListener: () => ({ remove: () => undefined }),
  },
  PixelRatio: { getFontScale: () => 1 },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

import { createLoadedUriCache } from '@elv/ui-kit';
import {
  attachDeadHostOnlineReset,
  createDesktopUiAdapters,
  type OnlineEventTargetLike,
} from './desktop-adapters.tsx';

describe('createDesktopUiAdapters (#311, #202)', () => {
  it('renders an Image element with valid RNW props and structured error forwarding', () => {
    const adapters = createDesktopUiAdapters();
    if (!adapters.renderImage) throw new Error('expected renderImage adapter');

    const onLoad = vi.fn();
    const onError = vi.fn();
    const element = adapters.renderImage({
      uri: 'https://cdn.example/poster.jpg',
      resizeMode: 'cover',
      maxDecodePx: 320,
      accessibilityLabel: 'Starlight Harbor',
      onLoad,
      onError,
    });

    const props = element.props as Record<string, unknown>;
    expect(props.source).toEqual({ uri: 'https://cdn.example/poster.jpg' });
    expect(props.resizeMode).toBe('cover');
    expect(props.accessibilityLabel).toBe('Starlight Harbor');
    expect(props.decoding).toBeUndefined();
    expect(props['data-max-decode-px']).toBeUndefined();
    expect(props.onLoad).toBe(onLoad);

    const handleError = props.onError as (event?: unknown) => void;
    handleError({ nativeEvent: { error: 'net::ERR_NAME_NOT_RESOLVED' } });
    expect(onError).toHaveBeenCalledWith({ message: 'net::ERR_NAME_NOT_RESOLVED' });

    handleError(undefined);
    expect(onError).toHaveBeenLastCalledWith(undefined);
  });

  it('wires artworkCache clear, setLimitBytes, and stats to Electron preload bridge and clears loadedUris (#405)', async () => {
    const loadedUris = createLoadedUriCache();
    loadedUris.markLoaded('https://cdn.example/poster.jpg');
    const artworkBridge = {
      clear: vi.fn(async () => undefined),
      setLimitBytes: vi.fn(async () => undefined),
      stats: vi.fn(async () => ({ bytes: 4096, entries: 3, maxBytes: 128 * 1024 * 1024 })),
    };

    const adapters = createDesktopUiAdapters({ artworkBridge, loadedUris });
    if (!adapters.artworkCache) throw new Error('expected artworkCache adapter');

    await adapters.artworkCache.setLimitBytes?.(256 * 1024 * 1024);
    expect(artworkBridge.setLimitBytes).toHaveBeenCalledWith(256 * 1024 * 1024);

    expect(await adapters.artworkCache.stats?.()).toEqual({
      bytes: 4096,
      entries: 3,
      maxBytes: 128 * 1024 * 1024,
    });

    await adapters.artworkCache.clear();
    expect(loadedUris.has('https://cdn.example/poster.jpg')).toBe(false);
    expect(artworkBridge.clear).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully without an Electron artwork bridge in browser mode (#405)', async () => {
    const loadedUris = createLoadedUriCache();
    loadedUris.markLoaded('https://cdn.example/a.jpg');
    const adapters = createDesktopUiAdapters({ loadedUris });
    if (!adapters.artworkCache) throw new Error('expected artworkCache adapter');

    await adapters.artworkCache.setLimitBytes?.(64 * 1024 * 1024);
    expect(await adapters.artworkCache.stats?.()).toEqual({
      bytes: 0,
      entries: 0,
      maxBytes: 64 * 1024 * 1024,
    });

    await adapters.artworkCache.clear();
    expect(loadedUris.size).toBe(0);
  });
});

describe('attachDeadHostOnlineReset (#202)', () => {
  it('resets the DeadHostRegistry on window online events and removes listener on dispose', () => {
    const reset = vi.fn();
    const listeners = new Set<() => void>();
    const target: OnlineEventTargetLike = {
      addEventListener(type, listener) {
        if (type === 'online') listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === 'online') listeners.delete(listener);
      },
    };

    const dispose = attachDeadHostOnlineReset(target, {
      isDead: () => false,
      recordFailure: () => false,
      recordSuccess: () => undefined,
      reset,
    });

    expect(listeners.size).toBe(1);
    for (const fn of listeners) fn();
    expect(reset).toHaveBeenCalledTimes(1);

    dispose();
    expect(listeners.size).toBe(0);
  });
});

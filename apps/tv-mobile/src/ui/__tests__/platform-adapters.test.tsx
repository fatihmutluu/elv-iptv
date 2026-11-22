import { createDeadHostRegistry } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { type AppStateStatus, View } from 'react-native';
import { attachAppStateDeadHostReset, createMobileTvUiAdapters } from '../platform-adapters';

let mockAppleDeviceModel: string | null = null;
let mockExpoFileSystem: unknown = null;

jest.mock('@elv/engine-aether', () => {
  const actual = jest.requireActual<typeof import('@elv/engine-aether')>('@elv/engine-aether');
  return {
    ...actual,
    getAppleDeviceModel: () => mockAppleDeviceModel,
  };
});

jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) =>
    name === 'FileSystem' ? mockExpoFileSystem : null,
}));

afterEach(() => {
  mockAppleDeviceModel = null;
  mockExpoFileSystem = null;
});

describe('createMobileTvUiAdapters (#311, #202)', () => {
  it('renders an Image with clamped maxDecodePx, resizeMethod="resize", fadeDuration={0}, and progressiveRenderingEnabled', async () => {
    const adapters = createMobileTvUiAdapters();
    if (!adapters.renderImage) throw new Error('expected renderImage adapter');

    const onLoad = jest.fn();
    const onError = jest.fn();
    await render(
      adapters.renderImage({
        uri: 'https://cdn.example/logo.png',
        resizeMode: 'contain',
        maxDecodePx: 120,
        accessibilityLabel: 'News HD',
        onLoad,
        onError,
      }),
    );

    const img = screen.getByLabelText('News HD');
    expect(img.props.source).toEqual({
      uri: 'https://cdn.example/logo.png',
      width: 120,
      height: 120,
    });
    expect(img.props.resizeMode).toBe('contain');
    expect(img.props.resizeMethod).toBe('resize');
    expect(img.props.fadeDuration).toBe(0);
    expect(img.props.progressiveRenderingEnabled).toBe(true);

    await fireEvent(img, 'load');
    expect(onLoad).toHaveBeenCalledTimes(1);

    await fireEvent(img, 'error', {
      nativeEvent: { error: 'java.net.UnknownHostException: Unable to resolve host' },
    });
    expect(onError).toHaveBeenCalledWith({
      message: 'java.net.UnknownHostException: Unable to resolve host',
    });
  });

  it('clamps sub-32 maxDecodePx to 32px and handles empty native error events safely', async () => {
    const adapters = createMobileTvUiAdapters();
    if (!adapters.renderImage) throw new Error('expected renderImage adapter');
    const onError = jest.fn();

    await render(
      adapters.renderImage({
        uri: 'https://cdn.example/tiny.png',
        resizeMode: 'cover',
        maxDecodePx: 12,
        accessibilityLabel: 'Tiny Icon',
        onError,
      }),
    );

    const img = screen.getByLabelText('Tiny Icon');
    expect(img.props.source).toEqual({
      uri: 'https://cdn.example/tiny.png',
      width: 32,
      height: 32,
    });

    await fireEvent(img, 'error');
    expect(onError).toHaveBeenCalledWith(undefined);
  });

  it('omits renderBlur on mid-power Apple TV hardware (AppleTV5,*, AppleTV6,*) and keeps it on standard hardware (#186)', () => {
    const renderBlur = () => <View testID="native-blur" />;

    for (const midPowerModel of ['AppleTV5,3', 'AppleTV6,2']) {
      mockAppleDeviceModel = midPowerModel;
      const adapters = createMobileTvUiAdapters({ renderBlur });
      expect(adapters.renderBlur).toBeUndefined();
    }

    for (const standardModel of ['AppleTV11,1', 'AppleTV14,1', 'iPhone16,1', null]) {
      mockAppleDeviceModel = standardModel;
      const adapters = createMobileTvUiAdapters({ renderBlur });
      expect(adapters.renderBlur).toBe(renderBlur);
    }

    expect(createMobileTvUiAdapters({ hardwareTier: 'mid-power', renderBlur }).renderBlur).toBe(
      undefined,
    );
    expect(createMobileTvUiAdapters({ hardwareTier: 'standard', renderBlur }).renderBlur).toBe(
      renderBlur,
    );
  });

  it('marks decorative renderImage calls without accessibilityLabel as accessible={false} (#186)', async () => {
    const adapters = createMobileTvUiAdapters();
    if (!adapters.renderImage) throw new Error('expected renderImage adapter');

    const view = await render(
      adapters.renderImage({
        uri: 'https://cdn.example/backdrop.jpg',
        resizeMode: 'cover',
        maxDecodePx: 640,
      }),
    );

    const tree = view.toJSON();
    expect(tree).not.toBeNull();
    if (tree === null || Array.isArray(tree)) throw new Error('expected single Image host node');
    expect(tree.props.accessible).toBe(false);
    expect(tree.props.accessibilityLabel).toBeUndefined();
  });

  it('wires a default artworkCache adapter with stats, setLimitBytes, and clear (#405)', async () => {
    const adapters = createMobileTvUiAdapters();
    if (!adapters.artworkCache) throw new Error('expected artworkCache adapter');

    await adapters.artworkCache.setLimitBytes?.(64 * 1024 * 1024);
    expect(await adapters.artworkCache.stats?.()).toEqual({
      bytes: 0,
      entries: 0,
      maxBytes: 64 * 1024 * 1024,
    });
    await expect(adapters.artworkCache.clear()).resolves.toBeUndefined();
  });

  it('wires the Expo native FileSystem port into artworkCache when available (#405)', async () => {
    const files = new Map<string, string | Uint8Array>();
    mockExpoFileSystem = {
      cacheDirectory: 'file:///device/cache/',
      FileSystemDirectory: class {
        readonly uri: string;
        constructor(uri: string) {
          this.uri = uri;
        }
        create() {
          return undefined;
        }
        listAsRecords() {
          const prefix = `${this.uri}/`;
          return [...files.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((uri) => ({ isDirectory: false, uri }));
        }
      },
      FileSystemFile: class {
        readonly uri: string;
        constructor(uri: string) {
          this.uri = uri;
        }
        info() {
          const entry = files.get(this.uri);
          if (entry === undefined) return { exists: false };
          return {
            exists: true,
            size: typeof entry === 'string' ? entry.length : entry.byteLength,
            modificationTime: 1000,
          };
        }
        async text() {
          const entry = files.get(this.uri);
          if (typeof entry !== 'string') throw new Error('ENOENT');
          return entry;
        }
        async write(content: string | Uint8Array) {
          files.set(this.uri, content);
        }
        delete() {
          files.delete(this.uri);
        }
      },
    };

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '8' },
      }),
    );

    try {
      const adapters = createMobileTvUiAdapters();
      const cached = await adapters.artworkCache?.resolveUri?.('https://cdn.example/art.png', 240);
      expect(cached).toMatch(/^file:\/\/\/device\/cache\/artwork-cache\/[a-f0-9]+\.img$/);
      expect((await adapters.artworkCache?.stats?.())?.bytes).toBe(8);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('attachAppStateDeadHostReset (#202)', () => {
  it('resets DeadHostRegistry only when returning from background to active', () => {
    const registry = createDeadHostRegistry();
    registry.recordFailure('https://offline.example/logo.png', { message: 'ENOTFOUND' });
    expect(registry.isDead('https://offline.example/other.png')).toBe(true);

    let listener: ((state: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    const fakeAppState = {
      currentState: 'active' as AppStateStatus,
      addEventListener: jest.fn((_type: 'change', cb: (state: AppStateStatus) => void) => {
        listener = cb;
        return { remove };
      }),
    };

    const detach = attachAppStateDeadHostReset(fakeAppState, registry);

    // inactive -> active should NOT reset
    listener?.('inactive');
    listener?.('active');
    expect(registry.isDead('https://offline.example/other.png')).toBe(true);

    // background -> active MUST reset so reconnected networks recover dead hosts
    listener?.('background');
    expect(registry.isDead('https://offline.example/other.png')).toBe(true);
    listener?.('active');
    expect(registry.isDead('https://offline.example/other.png')).toBe(false);

    // iOS/tvOS background -> inactive -> active MUST also reset
    registry.recordFailure('https://tvos-offline.example/logo.png', { message: 'ENOTFOUND' });
    expect(registry.isDead('https://tvos-offline.example/other.png')).toBe(true);
    listener?.('background');
    listener?.('inactive');
    expect(registry.isDead('https://tvos-offline.example/other.png')).toBe(true);
    listener?.('active');
    expect(registry.isDead('https://tvos-offline.example/other.png')).toBe(false);

    detach();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

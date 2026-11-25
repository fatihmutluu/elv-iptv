import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import { UiAdaptersProvider } from '../../adapters';
import { buildTheme, ThemeProvider } from '../../theme';
import { ArtworkImage } from '../ArtworkImage';
import { createLoadedUriCache } from '../artwork-cache';
import { createDeadHostRegistry } from '../dead-host-registry';

describe('ArtworkImage decode caps & error classification (#202, #311)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies bounded native decode hints, resizeMethod="resize", and fadeDuration={0} on native fallback Image', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const registry = createDeadHostRegistry();

    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/channel-logo.png"
          label="Channel One"
          maxDecodePx={128}
          deadHosts={registry}
          testID="logo"
        />
      </ThemeProvider>,
    );

    const img = screen.getByTestId('logo-img');
    expect(img.props.source).toEqual({
      uri: 'https://img.example/channel-logo.png',
      width: 128,
      height: 128,
    });
    expect(img.props.resizeMethod).toBe('resize');
    expect(img.props.fadeDuration).toBe(0);
  });

  it('clamps maxDecodePx to at least 32px for both fallback Image and custom renderImage adapter', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const registry = createDeadHostRegistry();
    const renderImage = jest.fn((props) => (
      <View testID="adapter-img" accessibilityLabel={props.uri} />
    ));

    const nativeView = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/tiny.png"
          label="Tiny"
          maxDecodePx={8}
          deadHosts={registry}
          testID="tiny"
        />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('tiny-img').props.source).toEqual({
      uri: 'https://img.example/tiny.png',
      width: 32,
      height: 32,
    });
    await nativeView.unmount();

    await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderImage }}>
          <ArtworkImage
            uri="https://img.example/tiny.png"
            label="Tiny"
            maxDecodePx={10}
            deadHosts={registry}
            testID="tiny-adapter"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(renderImage).toHaveBeenCalledWith(expect.objectContaining({ maxDecodePx: 32 }));
  });

  it('uses plain { uri } source on web fallback Image without unknown DOM props', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const registry = createDeadHostRegistry();

    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/poster.jpg"
          label="Web Poster"
          maxDecodePx={320}
          deadHosts={registry}
          testID="web-art"
        />
      </ThemeProvider>,
    );

    const img = screen.getByTestId('web-art-img');
    expect(img.props.source).toEqual({ uri: 'https://img.example/poster.jpg' });
    expect(img.props.decoding).toBeUndefined();
  });

  it('clears failedUri on load so recycled uriA(fail) -> uriB(ok) -> uriA retries after reset', async () => {
    const registry = createDeadHostRegistry();
    const view = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://retry.example/a.png"
          label="Channel A"
          deadHosts={registry}
          testID="slot"
        />
      </ThemeProvider>,
    );

    await fireEvent(screen.getByTestId('slot-img'), 'error', {
      nativeEvent: { error: 'ENOTFOUND' },
    });
    expect(screen.getByTestId('slot-fallback')).toBeTruthy();

    await view.rerender(
      <ThemeProvider>
        <ArtworkImage
          uri="https://healthy.example/b.png"
          label="Channel B"
          deadHosts={registry}
          testID="slot"
        />
      </ThemeProvider>,
    );
    await fireEvent(screen.getByTestId('slot-img'), 'load');

    registry.reset();
    await view.rerender(
      <ThemeProvider>
        <ArtworkImage
          uri="https://retry.example/a.png"
          label="Channel A"
          deadHosts={registry}
          testID="slot"
        />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('slot-img')).toBeTruthy();
    expect(screen.queryByTestId('slot-fallback')).toBeNull();
  });

  it('extracts nativeEvent.error so DNS failure trips immediately while HTTP 404 never blacklists the host', async () => {
    const registry = createDeadHostRegistry();

    const dnsView = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://dead-dns.example/logo.png"
          label="Dead DNS"
          deadHosts={registry}
          testID="dns-art"
        />
      </ThemeProvider>,
    );
    await fireEvent(screen.getByTestId('dns-art-img'), 'error', {
      nativeEvent: { error: 'java.net.UnknownHostException: Unable to resolve host' },
    });
    expect(screen.getByTestId('dns-art-fallback')).toBeTruthy();
    expect(registry.isDead('https://dead-dns.example/other.png')).toBe(true);
    await dnsView.unmount();

    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://healthy-cdn.example/missing.png"
          label="Missing Poster"
          deadHosts={registry}
          testID="missing-art"
        />
      </ThemeProvider>,
    );
    await fireEvent(screen.getByTestId('missing-art-img'), 'error', {
      nativeEvent: { error: 'HTTP 404 Not Found' },
    });
    expect(screen.getByTestId('missing-art-fallback')).toBeTruthy();
    expect(registry.isDead('https://healthy-cdn.example/present.png')).toBe(false);
  });

  it('forwards ImageErrorInfo from custom UiAdapters.renderImage onError into DeadHostRegistry', async () => {
    const registry = createDeadHostRegistry();
    let capturedOnError: ((error?: { message?: string; statusCode?: number }) => void) | undefined;

    await render(
      <ThemeProvider>
        <UiAdaptersProvider
          adapters={{
            renderImage: (props) => {
              capturedOnError = props.onError;
              return <View testID="custom-adapter-img" />;
            },
          }}
        >
          <ArtworkImage
            uri="https://adapter-dns.example/a.png"
            label="Adapter DNS"
            deadHosts={registry}
            testID="adapter-art"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(capturedOnError).toBeDefined();
    await fireEvent(screen.getByTestId('custom-adapter-img'), 'layout');
    capturedOnError?.({ message: 'NSURLErrorCannotFindHost' });
    expect(registry.isDead('https://adapter-dns.example/b.png')).toBe(true);
  });

  it('applies non-interactive hit-test and accessibility guards across outer, zoom, and fallback views when decorative (#186)', async () => {
    const registry = createDeadHostRegistry();

    const loaded = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/backdrop.jpg"
          label="Hero Backdrop"
          decorative
          deadHosts={registry}
          testID="hero-bg"
        />
      </ThemeProvider>,
    );

    const outer = screen.getByTestId('hero-bg', { includeHiddenElements: true });
    expect(outer.props.pointerEvents).toBe('none');
    expect(outer.props.accessible).toBe(false);
    expect(outer.props.accessibilityElementsHidden).toBe(true);
    expect(outer.props.importantForAccessibility).toBe('no');

    const zoom = screen.getByTestId('hero-bg-zoom', { includeHiddenElements: true });
    expect(zoom.props.pointerEvents).toBe('none');
    expect(zoom.props.accessible).toBe(false);
    expect(zoom.props.accessibilityElementsHidden).toBe(true);
    expect(zoom.props.importantForAccessibility).toBe('no');

    const img = screen.getByTestId('hero-bg-img', { includeHiddenElements: true });
    expect(img.props.accessible).toBe(false);
    expect(img.props.accessibilityLabel).toBeUndefined();
    await loaded.unmount();

    await render(
      <ThemeProvider>
        <ArtworkImage
          uri={null}
          label="Missing Backdrop"
          decorative
          deadHosts={registry}
          testID="hero-empty"
        />
      </ThemeProvider>,
    );

    const emptyOuter = screen.getByTestId('hero-empty', { includeHiddenElements: true });
    expect(emptyOuter.props.pointerEvents).toBe('none');
    expect(emptyOuter.props.accessible).toBe(false);
    expect(emptyOuter.props.accessibilityElementsHidden).toBe(true);
    expect(emptyOuter.props.importantForAccessibility).toBe('no');

    const fallback = screen.getByTestId('hero-empty-fallback', { includeHiddenElements: true });
    expect(fallback.props.pointerEvents).toBe('none');
    expect(fallback.props.accessible).toBe(false);
    expect(fallback.props.accessibilityElementsHidden).toBe(true);
    expect(fallback.props.importantForAccessibility).toBe('no');
    expect(fallback.props.accessibilityLabel).toBeUndefined();
  });
});

describe('ArtworkImage ambient placeholder, loaded-URI cache & resolveUri (#405)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows ambient placeholder until onLoad, then reveals image and caches URI for zero-flicker revisits', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();
    const theme = buildTheme();

    const firstMount = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/cinema-1.jpg"
          label="Cinema One"
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="poster"
        />
      </ThemeProvider>,
    );

    const placeholder = screen.getByTestId('poster-placeholder', { includeHiddenElements: true });
    expect(StyleSheet.flatten(placeholder.props.style).backgroundColor).toBe(
      theme.colors.bgElevated,
    );
    expect(placeholder.props.pointerEvents).toBe('none');

    const revealBefore = StyleSheet.flatten(screen.getByTestId('poster-reveal').props.style);
    expect(revealBefore.opacity).toBe(0);
    expect((revealBefore as Record<string, unknown>).transitionProperty).toBe('opacity');
    expect((revealBefore as Record<string, unknown>).transitionDuration).toBe('180ms');

    await fireEvent(screen.getByTestId('poster-img'), 'load');

    expect(loadedUris.has('https://img.example/cinema-1.jpg')).toBe(true);
    expect(screen.queryByTestId('poster-placeholder', { includeHiddenElements: true })).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('poster-reveal').props.style).opacity).toBe(1);
    await firstMount.unmount();

    // Revisiting an already-loaded URI must start synchronously at opacity 1 with zero placeholder
    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/cinema-1.jpg"
          label="Cinema One"
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="revisit"
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('revisit-placeholder', { includeHiddenElements: true })).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('revisit-reveal').props.style).opacity).toBe(1);
  });

  it('reveals immediately at opacity 1 without transition when reduceMotion is enabled', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();

    await render(
      <ThemeProvider reduceMotion>
        <ArtworkImage
          uri="https://img.example/still.jpg"
          label="Reduced Motion"
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="rm"
        />
      </ThemeProvider>,
    );

    const revealStyle = StyleSheet.flatten(screen.getByTestId('rm-reveal').props.style);
    expect(revealStyle.opacity).toBe(1);
    expect((revealStyle as Record<string, unknown>).transitionProperty).toBe('none');
  });

  it('waits for artworkCache.resolveUri before rendering Image (single request, no double-download) and falls back on local error', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();
    let resolvePending: ((uri: string | null) => void) | undefined;
    const resolveUri = jest.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePending = resolve;
        }),
    );

    await render(
      <ThemeProvider>
        <UiAdaptersProvider
          adapters={{
            artworkCache: {
              resolveUri,
              clear: async () => undefined,
            },
          }}
        >
          <ArtworkImage
            uri="https://cdn.example/cached.jpg"
            label="Cached Art"
            maxDecodePx={240}
            deadHosts={registry}
            loadedUris={loadedUris}
            testID="cached"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(resolveUri).toHaveBeenCalledTimes(1);
    expect(resolveUri).toHaveBeenCalledWith('https://cdn.example/cached.jpg', 240);
    // While resolveUri is in flight, show placeholder and do NOT issue a parallel <Image> network request
    expect(screen.getByTestId('cached-placeholder', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('cached-img')).toBeNull();

    await act(async () => {
      resolvePending?.('file:///cache/artwork/abc.img');
    });

    expect(screen.getByTestId('cached-img').props.source.uri).toBe('file:///cache/artwork/abc.img');

    // If the cached local file fails, fall back to the original network URI without poisoning deadHosts
    await fireEvent(screen.getByTestId('cached-img'), 'error', {
      nativeEvent: { error: 'ENOENT' },
    });
    expect(screen.getByTestId('cached-img').props.source.uri).toBe(
      'https://cdn.example/cached.jpg',
    );
    expect(registry.isDead('https://cdn.example/cached.jpg')).toBe(false);
  });

  it('falls back cleanly to original URI when resolveUri returns null or rejects', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();

    const nullView = await render(
      <ThemeProvider>
        <UiAdaptersProvider
          adapters={{
            artworkCache: {
              resolveUri: jest.fn(async () => null),
              clear: async () => undefined,
            },
          }}
        >
          <ArtworkImage
            uri="https://cdn.example/null-resolve.jpg"
            label="Null Resolve"
            deadHosts={registry}
            loadedUris={loadedUris}
            testID="null-res"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('null-res-img').props.source.uri).toBe(
      'https://cdn.example/null-resolve.jpg',
    );
    await nullView.unmount();

    await render(
      <ThemeProvider>
        <UiAdaptersProvider
          adapters={{
            artworkCache: {
              resolveUri: jest.fn(async () => {
                throw new Error('ipc failed');
              }),
              clear: async () => undefined,
            },
          }}
        >
          <ArtworkImage
            uri="https://cdn.example/reject-resolve.jpg"
            label="Reject Resolve"
            deadHosts={registry}
            loadedUris={loadedUris}
            testID="reject-res"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('reject-res-img').props.source.uri).toBe(
      'https://cdn.example/reject-resolve.jpg',
    );
  });

  it('ignores stale onLoad and onError callbacks from recycled slot A after prop switches to URI B', async () => {
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();
    const capturedByUri = new Map<
      string,
      { onLoad?: () => void; onError?: (err?: { message?: string }) => void }
    >();

    const renderImage = jest.fn(
      (props: {
        uri: string;
        onLoad?: () => void;
        onError?: (err?: { message?: string }) => void;
      }) => {
        capturedByUri.set(props.uri, { onLoad: props.onLoad, onError: props.onError });
        return <View testID="recycled-img" accessibilityLabel={props.uri} />;
      },
    );

    const view = await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderImage }}>
          <ArtworkImage
            uri="https://host-a.example/poster-a.jpg"
            label="Poster A"
            deadHosts={registry}
            loadedUris={loadedUris}
            testID="slot"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    const callbacksA = capturedByUri.get('https://host-a.example/poster-a.jpg');
    expect(callbacksA?.onLoad).toBeDefined();
    expect(callbacksA?.onError).toBeDefined();

    // Recycle pooled slot to URI B before A settles
    await view.rerender(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderImage }}>
          <ArtworkImage
            uri="https://host-b.example/poster-b.jpg"
            label="Poster B"
            deadHosts={registry}
            loadedUris={loadedUris}
            testID="slot"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    // Late onLoad from A must NOT mark B loaded or hide B's placeholder
    await act(async () => {
      callbacksA?.onLoad?.();
    });
    expect(loadedUris.has('https://host-b.example/poster-b.jpg')).toBe(false);
    expect(loadedUris.has('https://host-a.example/poster-a.jpg')).toBe(false);
    expect(screen.getByTestId('slot-placeholder', { includeHiddenElements: true })).toBeTruthy();

    // Late onError (DNS failure) from A must NOT mark B failed or blacklist B's host
    await act(async () => {
      callbacksA?.onError?.({ message: 'ENOTFOUND' });
    });
    expect(registry.isDead('https://host-b.example/other.jpg')).toBe(false);
    expect(registry.isDead('https://host-a.example/other.jpg')).toBe(false);
    expect(screen.queryByTestId('slot-fallback')).toBeNull();
    expect(screen.getByTestId('recycled-img').props.accessibilityLabel).toBe(
      'https://host-b.example/poster-b.jpg',
    );

    // Real onLoad from B still works cleanly
    const callbacksB = capturedByUri.get('https://host-b.example/poster-b.jpg');
    await act(async () => {
      callbacksB?.onLoad?.();
    });
    expect(loadedUris.has('https://host-b.example/poster-b.jpg')).toBe(true);
    expect(screen.queryByTestId('slot-placeholder', { includeHiddenElements: true })).toBeNull();
  });

  it('does not invoke resolveUri for confirmed dead hosts', async () => {
    const registry = createDeadHostRegistry();
    registry.recordFailure('https://dead.example/logo.png', { message: 'ENOTFOUND' });
    const resolveUri = jest.fn(async () => 'file:///cache/never.img');

    await render(
      <ThemeProvider>
        <UiAdaptersProvider
          adapters={{
            artworkCache: { resolveUri, clear: async () => undefined },
          }}
        >
          <ArtworkImage
            uri="https://dead.example/logo.png"
            label="Dead"
            deadHosts={registry}
            testID="dead"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(resolveUri).not.toHaveBeenCalled();
    expect(screen.getByTestId('dead-fallback')).toBeTruthy();
  });
});

describe('ArtworkImage channel-logo readability modes (#126)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('supports plate, invert (web CSS filter vs native plate), and off modes with legacy logoBackdrop compatibility', async () => {
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();
    const defaultTheme = buildTheme();
    const hcTheme = buildTheme({ preset: 'highContrast' });

    // Web invert applies CSS invert filter on logo wrapper and keeps dark frame
    jest.replaceProperty(Platform, 'OS', 'web');
    const webInvert = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/dark-logo.png"
          label="Dark Logo"
          resizeMode="contain"
          logoBackdropMode="invert"
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="web-invert"
        />
      </ThemeProvider>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('web-invert').props.style).backgroundColor).toBe(
      defaultTheme.colors.bgCard,
    );
    expect(
      (
        StyleSheet.flatten(screen.getByTestId('web-invert-reveal').props.style) as Record<
          string,
          unknown
        >
      ).filter,
    ).toBe('invert(1) brightness(1.15)');
    await webInvert.unmount();

    // Native invert applies high-readability light-neutral backing plate instead of CSS filter
    jest.replaceProperty(Platform, 'OS', 'android');
    const nativeInvert = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/dark-logo.png"
          label="Dark Logo"
          resizeMode="contain"
          logoBackdropMode="invert"
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="native-invert"
        />
      </ThemeProvider>,
    );
    const nativeInvertFrame = StyleSheet.flatten(screen.getByTestId('native-invert').props.style);
    expect(nativeInvertFrame.backgroundColor).toBe(defaultTheme.colors.actionGlassHoverBg);
    expect(nativeInvertFrame.padding).toBe(defaultTheme.spacing.xxs);
    expect(
      (
        StyleSheet.flatten(screen.getByTestId('native-invert-reveal').props.style) as Record<
          string,
          unknown
        >
      ).filter,
    ).toBeUndefined();
    await nativeInvert.unmount();

    // Plate mode in High Contrast AAA adds subtle border and padding for contain logos
    const plateHc = await render(
      <ThemeProvider preset="highContrast">
        <ArtworkImage
          uri="https://img.example/ch.png"
          label="Channel HC"
          resizeMode="contain"
          logoBackdrop
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="plate-hc"
        />
      </ThemeProvider>,
    );
    const plateFrame = StyleSheet.flatten(screen.getByTestId('plate-hc').props.style);
    expect(plateFrame.backgroundColor).toBe(hcTheme.colors.subtleHighlight);
    expect(plateFrame.borderWidth).toBe(1);
    expect(plateFrame.borderColor).toBe(hcTheme.colors.surfaceBorder);
    expect(plateFrame.padding).toBe(hcTheme.spacing.xxs);
    await plateHc.unmount();

    // Explicit logoBackdropMode="off" overrides legacy logoBackdrop={true}
    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/raw.png"
          label="Raw Logo"
          resizeMode="contain"
          logoBackdrop
          logoBackdropMode="off"
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="off-mode"
        />
      </ThemeProvider>,
    );
    const offFrame = StyleSheet.flatten(screen.getByTestId('off-mode').props.style);
    expect(offFrame.backgroundColor).toBe(defaultTheme.colors.bgCard);
    expect(offFrame.padding).toBeUndefined();
  });

  it('never applies subtleHighlight plate behind opaque fallback or placeholder surfaces', async () => {
    const registry = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();
    const defaultTheme = buildTheme();

    // Missing/failed logo with logoBackdrop=true must keep bgCard (no subtleHighlight halo behind fallback)
    const fallbackView = await render(
      <ThemeProvider>
        <ArtworkImage
          uri={null}
          label="Missing Live Logo"
          logoBackdrop
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="logo-fallback"
        />
      </ThemeProvider>,
    );
    const fbFrame = StyleSheet.flatten(screen.getByTestId('logo-fallback').props.style);
    expect(fbFrame.backgroundColor).toBe(defaultTheme.colors.bgCard);
    expect(fbFrame.padding).toBeUndefined();
    await fallbackView.unmount();

    // Loading logo with logoBackdrop=true uses the plate directly without an opaque dark placeholder
    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/live-logo.png"
          label="Live Logo"
          logoBackdrop
          deadHosts={registry}
          loadedUris={loadedUris}
          testID="logo-loading"
        />
      </ThemeProvider>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('logo-loading').props.style).backgroundColor).toBe(
      defaultTheme.colors.subtleHighlight,
    );
    expect(
      screen.queryByTestId('logo-loading-placeholder', { includeHiddenElements: true }),
    ).toBeNull();
  });
});

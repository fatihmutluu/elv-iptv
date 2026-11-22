import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { UiAdaptersProvider } from '../../adapters';
import { ThemeProvider } from '../../theme';
import { ArtworkImage } from '../ArtworkImage';
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

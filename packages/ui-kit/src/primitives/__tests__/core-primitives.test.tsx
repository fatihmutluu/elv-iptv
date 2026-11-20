import { createAppI18n } from '@elv/i18n';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text, View } from 'react-native';
import { UiAdaptersProvider } from '../../adapters';
import { I18nProvider } from '../../i18n';
import { Icon } from '../../icons';
import { buildTheme, ThemeProvider } from '../../theme';
import { ViewportProvider } from '../../viewport';
import { AdaptiveSheet } from '../AdaptiveSheet';
import { ArtworkImage } from '../ArtworkImage';
import { createDeadHostRegistry, extractArtworkHost } from '../dead-host-registry';
import { ErrorBoundary } from '../ErrorBoundary';
import { GlassBar } from '../GlassBar';
import { Scrim } from '../Scrim';
import { Surface } from '../Surface';

describe('DeadHostRegistry & ArtworkImage (#126, #202, #311)', () => {
  it('extracts normalized hosts including IPv6 ports and trips circuit breaker after threshold', () => {
    expect(extractArtworkHost('HTTPS://CDN.Example.COM:8443/logo.png')).toBe(
      'cdn.example.com:8443',
    );
    expect(extractArtworkHost('http://[2001:db8::1]:8080/poster.jpg')).toBe('[2001:db8::1]:8080');
    expect(extractArtworkHost('data:image/png;base64,abc')).toBeNull();
    expect(extractArtworkHost('not-a-url')).toBeNull();

    const registry = createDeadHostRegistry({ failureThreshold: 2 });
    const url = 'https://dead.example/p1.jpg';
    expect(registry.isDead(url)).toBe(false);
    expect(registry.recordFailure(url)).toBe(false);
    expect(registry.recordFailure('https://dead.example/p2.jpg')).toBe(true);
    expect(registry.isDead('https://dead.example/p3.jpg')).toBe(true);

    registry.recordSuccess(url);
    expect(registry.isDead(url)).toBe(false);
  });

  it('handles emoji monograms, recycled dead-host slots synchronously, and renderImage maxDecodePx', async () => {
    const registry = createDeadHostRegistry({ failureThreshold: 1 });
    registry.recordFailure('https://dead-slot.example/x.jpg');
    const renderImage = jest.fn((props) => (
      <View testID="custom-img" accessibilityLabel={props.uri} />
    ));

    const missing = await render(
      <ThemeProvider>
        <ArtworkImage label="🎬 Starlight Harbor" testID="art" deadHosts={registry} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('art-fallback')).toBeTruthy();
    expect(screen.getByText('SH')).toBeTruthy();
    await missing.unmount();

    const recycled = await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderImage }}>
          <ArtworkImage
            uri="https://img.example/poster.jpg"
            label="Starlight Harbor"
            maxDecodePx={320}
            logoBackdrop
            deadHosts={registry}
            testID="art"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('custom-img')).toBeTruthy();
    expect(renderImage).toHaveBeenCalledTimes(1);
    expect(renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://img.example/poster.jpg', maxDecodePx: 320 }),
    );

    // Recycling directly to a confirmed dead host must NEVER mount renderImage even for 1 frame.
    await recycled.rerender(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderImage }}>
          <ArtworkImage
            uri="https://dead-slot.example/new.jpg"
            label="Dead Channel"
            deadHosts={registry}
            testID="art"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(renderImage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('art-fallback')).toBeTruthy();
    await recycled.unmount();

    await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://broken.example/a.jpg"
          label="News 24"
          deadHosts={registry}
          testID="b"
        />
      </ThemeProvider>,
    );
    await fireEvent(screen.getByTestId('b-img'), 'error');
    expect(screen.getByTestId('b-fallback')).toBeTruthy();
    expect(registry.isDead('https://broken.example/other.jpg')).toBe(true);
  });

  it('supports optional zoomed scaling and disables zoom when reduceMotion is active', async () => {
    const registry = createDeadHostRegistry();
    const zoomedView = await render(
      <ThemeProvider>
        <ArtworkImage
          uri="https://img.example/zoom.jpg"
          label="Zoom Poster"
          zoomed
          deadHosts={registry}
          testID="zoom-art"
        />
      </ThemeProvider>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('zoom-art-zoom').props.style).transform).toEqual([
      { scale: 1.05 },
    ]);
    await zoomedView.unmount();

    await render(
      <ThemeProvider reduceMotion>
        <ArtworkImage
          uri="https://img.example/zoom.jpg"
          label="Zoom Poster"
          zoomed
          deadHosts={registry}
          testID="reduced-art"
        />
      </ThemeProvider>,
    );
    expect(
      StyleSheet.flatten(screen.getByTestId('reduced-art-zoom').props.style).transform,
    ).toBeUndefined();
  });
});

describe('Surface, Scrim, GlassBar & Icon adapters + native fallbacks', () => {
  it('delegates gradient, blur, and svg rendering to UiAdapters and supports fallback rendering', async () => {
    const renderGradient = jest.fn(() => <View testID="adapter-grad" />);
    const renderBlur = jest.fn(({ children }) => <View testID="adapter-blur">{children}</View>);
    const renderSvg = jest.fn(() => <View testID="adapter-svg" />);
    const hc = buildTheme({ preset: 'highContrast' });

    const adapted = await render(
      <ThemeProvider preset="highContrast">
        <UiAdaptersProvider adapters={{ renderGradient, renderBlur, renderSvg }}>
          <Surface tone="elevated" bordered rounded="card" testID="surface">
            <Scrim direction="bottom" intensity="strong" testID="scrim" />
            <GlassBar scrolled={false} testID="glass-top" />
            <GlassBar scrolled testID="glass">
              <Icon name="play" size={18} testID="icon" />
            </GlassBar>
          </Surface>
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('surface')).toBeTruthy();
    expect(screen.getAllByTestId('adapter-grad')).toHaveLength(2);
    expect(screen.getByTestId('adapter-blur')).toBeTruthy();
    expect(screen.getByTestId('adapter-svg')).toBeTruthy();
    expect(renderGradient).toHaveBeenCalledWith(
      expect.objectContaining({
        colors: expect.arrayContaining(['#000000']),
        locations: [0, 0.34, 0.72, 1],
      }),
    );
    expect(renderGradient).toHaveBeenCalledWith(
      expect.objectContaining({
        colors: [hc.colors.topBarScrimStart, hc.colors.topBarScrimMid, hc.colors.scrimTransparent],
        locations: [0, 0.68, 1],
      }),
    );
    await adapted.unmount();

    await render(
      <ThemeProvider>
        <GlassBar scrolled={false} testID="glass-unscrolled">
          <Icon name="search" size={20} accessibilityLabel="Search" testID="icon-fallback" />
        </GlassBar>
        <GlassBar scrolled hairlineEdge="top" testID="glass-scrolled">
          <Scrim direction="left" testID="scrim-fallback" />
        </GlassBar>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('glass-unscrolled')).toBeTruthy();
    expect(screen.getByTestId('glass-scrolled')).toBeTruthy();
    expect(
      StyleSheet.flatten(screen.getByTestId('glass-scrolled').props.style).backgroundColor,
    ).toBe(buildTheme().colors.glassBg);
    expect(screen.getByTestId('icon-fallback')).toBeTruthy();
    expect(screen.getByTestId('scrim-fallback')).toBeTruthy();
  });
});

describe('AdaptiveSheet', () => {
  it('renders right-anchored popover in Landscape, keeps backdrop non-focusable, and localizes in TR', async () => {
    const onDismiss = jest.fn();
    const tr = createAppI18n('tr');

    const landscape = await render(
      <I18nProvider i18n={tr}>
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
          >
            <AdaptiveSheet visible title="Ayarlar" onDismiss={onDismiss} testID="sheet">
              <Text>Content</Text>
            </AdaptiveSheet>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );
    const panel = screen.getByTestId('sheet-panel');
    expect(panel).toBeTruthy();
    expect(StyleSheet.flatten(panel.props.style).elevation).toBeGreaterThan(0);
    const header = screen.getByTestId('sheet-header');
    expect(StyleSheet.flatten(header.props.style).borderBottomWidth).toBe(StyleSheet.hairlineWidth);
    expect(screen.queryByTestId('sheet-handle')).toBeNull();
    const backdrop = screen.getByTestId('sheet-backdrop');
    expect(backdrop.props.focusable).toBe(false);
    expect(backdrop.props.accessibilityLabel).toBe('Kapat');
    await fireEvent.press(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await landscape.unmount();

    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'phone', orientation: 'portrait', width: 390, height: 844 }}
        >
          <AdaptiveSheet visible title="Settings" onDismiss={onDismiss} testID="sheet">
            <Text>Content</Text>
          </AdaptiveSheet>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('sheet-handle')).toBeTruthy();
  });
});

function FlakyChild({ shouldThrow }: { shouldThrow: () => boolean }) {
  if (shouldThrow()) throw new Error('boom');
  return <Text testID="recovered">OK</Text>;
}

describe('ErrorBoundary (#159)', () => {
  it('catches render errors with localized TR fallback copy and recovers cleanly when retry is pressed', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = jest.fn();
    const tr = createAppI18n('tr');
    let shouldThrow = true;

    await render(
      <I18nProvider i18n={tr}>
        <ThemeProvider>
          <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
            <ErrorBoundary onError={onError} testID="eb">
              <FlakyChild shouldThrow={() => shouldThrow} />
            </ErrorBoundary>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.getByTestId('eb')).toBeTruthy();
    expect(screen.getByText('Bir sorun oluştu')).toBeTruthy();
    expect(screen.getByText('Tekrar dene')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);

    shouldThrow = false;
    await fireEvent.press(screen.getByTestId('eb-retry'));
    expect(screen.getByTestId('recovered')).toBeTruthy();
    errSpy.mockRestore();
  });
});

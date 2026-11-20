import { render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import { UiAdaptersProvider } from '../../adapters';
import { buildTheme, ThemeProvider } from '../../theme';
import { ViewportProvider } from '../../viewport';
import { createDeadHostRegistry, type DeadHostRegistry } from '../dead-host-registry';
import { IconButton } from '../IconButton';
import { PosterCard } from '../PosterCard';
import { SkeletonBox } from '../SkeletonBox';
import { WideCard } from '../WideCard';

const defaultTheme = buildTheme();
const hcTheme = buildTheme({ preset: 'highContrast' });
const flat = StyleSheet.flatten;

function MemoHarness({ tick, deadHosts }: { tick: number; deadHosts: DeadHostRegistry }) {
  return (
    <View testID={`tick-${tick}`}>
      <PosterCard
        title="Stable Poster"
        imageUri="https://e.co/stable-p.jpg"
        deadHosts={deadHosts}
      />
      <WideCard title="Stable Wide" imageUri="https://e.co/stable-w.jpg" deadHosts={deadHosts} />
    </View>
  );
}

describe('TV focus isolation (focusable prop)', () => {
  it('honors focusable={false} and sensible defaults on IconButton, PosterCard, and WideCard', async () => {
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
          <IconButton icon="plus" accessibilityLabel="Default icon" testID="icon-default" />
          <IconButton
            icon="plus"
            accessibilityLabel="Disabled icon"
            disabled
            testID="icon-disabled"
          />
          <IconButton
            icon="plus"
            accessibilityLabel="Isolated icon"
            focusable={false}
            testID="icon-isolated"
          />
          <PosterCard title="Default Poster" testID="poster-default" />
          <PosterCard title="Isolated Poster" focusable={false} testID="poster-isolated" />
          <WideCard title="Default Wide" testID="wide-default" />
          <WideCard title="Isolated Wide" focusable={false} testID="wide-isolated" />
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('icon-default').props.focusable).toBe(true);
    expect(screen.getByTestId('icon-disabled').props.focusable).toBe(false);
    expect(screen.getByTestId('icon-isolated').props.focusable).toBe(false);
    expect(screen.getByTestId('poster-default').props.focusable).toBe(true);
    expect(screen.getByTestId('poster-isolated').props.focusable).toBe(false);
    expect(screen.getByTestId('wide-default').props.focusable).toBe(true);
    expect(screen.getByTestId('wide-isolated').props.focusable).toBe(false);
  });
});

describe('Low-RAM maxDecodePx forwarding & memoized cards', () => {
  it('forwards default (320/480) and custom maxDecodePx to ArtworkImage', async () => {
    const renderImage = jest.fn((props) => <View testID={`img-${props.uri}`} />);
    const deadHosts = createDeadHostRegistry();

    await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderImage }}>
          <PosterCard
            title="Default Poster"
            imageUri="https://e.co/p1.jpg"
            deadHosts={deadHosts}
            testID="p1"
          />
          <PosterCard
            title="Custom Poster"
            imageUri="https://e.co/p2.jpg"
            maxDecodePx={240}
            deadHosts={deadHosts}
            testID="p2"
          />
          <WideCard
            title="Default Wide"
            imageUri="https://e.co/w1.jpg"
            deadHosts={deadHosts}
            testID="w1"
          />
          <WideCard
            title="Custom Wide"
            imageUri="https://e.co/w2.jpg"
            maxDecodePx={640}
            deadHosts={deadHosts}
            testID="w2"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://e.co/p1.jpg', maxDecodePx: 320 }),
    );
    expect(renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://e.co/p2.jpg', maxDecodePx: 240 }),
    );
    expect(renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://e.co/w1.jpg', maxDecodePx: 480 }),
    );
    expect(renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://e.co/w2.jpg', maxDecodePx: 640 }),
    );
  });

  it('memoizes PosterCard and WideCard to skip re-renders when props are unchanged', async () => {
    const renderImage = jest.fn((props) => <View testID={`memo-${props.uri}`} />);
    const deadHosts = createDeadHostRegistry();
    const adapters = { renderImage };

    const view = await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={adapters}>
          <MemoHarness tick={1} deadHosts={deadHosts} />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(renderImage).toHaveBeenCalledTimes(2);

    await view.rerender(
      <ThemeProvider>
        <UiAdaptersProvider adapters={adapters}>
          <MemoHarness tick={2} deadHosts={deadHosts} />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('tick-2')).toBeTruthy();
    expect(renderImage).toHaveBeenCalledTimes(2);
  });
});

describe('SkeletonBox (zero-CLS tonal placeholder)', () => {
  it('renders static tonal block with dimensions, aspectRatio, and hidden accessibility on native', async () => {
    await render(
      <ThemeProvider>
        <SkeletonBox width={160} aspectRatio={2 / 3} testID="skel-poster" />
        <SkeletonBox
          width="100%"
          height={18}
          borderRadius={4}
          style={{ marginTop: 8 }}
          testID="skel-line"
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('skel-poster')).toBeNull();
    const poster = screen.getByTestId('skel-poster', { includeHiddenElements: true });
    expect(poster.props.accessibilityElementsHidden).toBe(true);
    expect(poster.props.importantForAccessibility).toBe('no-hide-descendants');
    const posterStyle = flat(poster.props.style) as Record<string, unknown>;
    expect(posterStyle.backgroundColor).toBe(defaultTheme.colors.bgCard);
    expect(posterStyle.borderRadius).toBe(defaultTheme.radius.card);
    expect(posterStyle.width).toBe(160);
    expect(posterStyle.aspectRatio).toBeCloseTo(2 / 3);
    expect(posterStyle.borderWidth).toBeUndefined();
    expect(posterStyle.animationName).toBeUndefined();

    const lineStyle = flat(
      screen.getByTestId('skel-line', { includeHiddenElements: true }).props.style,
    ) as Record<string, unknown>;
    expect(lineStyle.width).toBe('100%');
    expect(lineStyle.height).toBe(18);
    expect(lineStyle.borderRadius).toBe(4);
    expect(lineStyle.marginTop).toBe(8);
  });

  it('adds hairline surfaceBorder in highContrast AAA mode', async () => {
    await render(
      <ThemeProvider preset="highContrast">
        <SkeletonBox width={200} height={112} testID="skel-hc" />
      </ThemeProvider>,
    );

    const hcStyle = flat(
      screen.getByTestId('skel-hc', { includeHiddenElements: true }).props.style,
    );
    expect(hcStyle.backgroundColor).toBe(hcTheme.colors.bgCard);
    expect(hcStyle.borderWidth).toBe(StyleSheet.hairlineWidth);
    expect(hcStyle.borderColor).toBe(hcTheme.colors.surfaceBorder);
  });

  it('enables gentle CSS pulse on web only when reduceMotion is false', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      const animated = await render(
        <ThemeProvider reduceMotion={false}>
          <SkeletonBox width={120} height={120} testID="skel-web" />
        </ThemeProvider>,
      );
      const webStyle = flat(
        screen.getByTestId('skel-web', { includeHiddenElements: true }).props.style,
      ) as Record<string, unknown>;
      expect(webStyle.animationName).toBe('elv-skeleton-pulse');
      await animated.unmount();

      await render(
        <ThemeProvider reduceMotion>
          <SkeletonBox width={120} height={120} testID="skel-web-rm" />
        </ThemeProvider>,
      );
      const rmStyle = flat(
        screen.getByTestId('skel-web-rm', { includeHiddenElements: true }).props.style,
      ) as Record<string, unknown>;
      expect(rmStyle.animationName).toBeUndefined();
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    }
  });
});

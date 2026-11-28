import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { ThemeProvider } from '../../theme';
import { ViewportProvider } from '../../viewport';
import { PosterCard } from '../PosterCard';

interface WebCardStyle {
  boxShadow?: string;
  transitionProperty?: string;
}

describe('PosterCard web compositor safety', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not emit a box-shadow CSS transition and keeps a static rest boxShadow on hover', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <PosterCard title="Nebula Drift" testID="web-poster" />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const cardStyle = StyleSheet.flatten(
      screen.getByTestId('web-poster').props.style,
    ) as WebCardStyle;
    expect(cardStyle.transitionProperty).toBe('transform, opacity');

    const frameBefore = StyleSheet.flatten(
      screen.getByTestId('web-poster-artwork-frame').props.style,
    ) as WebCardStyle;
    expect(frameBefore.boxShadow).toBe('0 8px 22px rgba(0, 0, 0, 0.44)');
    expect(frameBefore.transitionProperty).toBeUndefined();

    await fireEvent(screen.getByTestId('web-poster'), 'hoverIn');
    const frameHover = StyleSheet.flatten(
      screen.getByTestId('web-poster-artwork-frame').props.style,
    ) as WebCardStyle;
    expect(frameHover.boxShadow).toBe('0 8px 22px rgba(0, 0, 0, 0.44)');
    expect(frameHover.transitionProperty).toBeUndefined();
    expect(screen.getByTestId('web-poster-focus-ring')).toBeTruthy();
  });
});

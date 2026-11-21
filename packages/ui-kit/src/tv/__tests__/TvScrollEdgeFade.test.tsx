import { render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import { UiAdaptersProvider } from '../../adapters';
import { buildTheme, ThemeProvider } from '../../theme';
import { TvScrollEdgeFade } from '../TvScrollEdgeFade';

describe('TvScrollEdgeFade (#230)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('auto-enables on tvOS (ios + isTV) and stays off by default on non-tvOS platforms', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const androidView = await render(
      <ThemeProvider>
        <TvScrollEdgeFade showTop showBottom testID="fade" />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('fade')).toBeNull();
    await androidView.unmount();

    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    await render(
      <ThemeProvider>
        <TvScrollEdgeFade showTop showBottom testID="fade" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('fade')).toBeTruthy();
    expect(screen.getByTestId('fade-top')).toBeTruthy();
    expect(screen.getByTestId('fade-bottom')).toBeTruthy();
    expect(screen.getByTestId('fade').props.pointerEvents).toBe('none');
  });

  it('renders only requested edges with custom height and returns null when both edges are hidden', async () => {
    const view = await render(
      <ThemeProvider>
        <TvScrollEdgeFade enabled showTop={false} showBottom height={36} testID="edge" />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('edge-top')).toBeNull();
    const bottom = screen.getByTestId('edge-bottom');
    expect(StyleSheet.flatten(bottom.props.style)).toEqual(
      expect.objectContaining({ position: 'absolute', bottom: 0, height: 36 }),
    );

    await view.rerender(
      <ThemeProvider>
        <TvScrollEdgeFade enabled showTop={false} showBottom={false} testID="edge" />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('edge')).toBeNull();
  });

  it('derives gradient stops from theme.colors.bgCanvas (including High Contrast AAA) via Scrim', async () => {
    const renderGradient = jest.fn(() => <View testID="grad" />);
    const hc = buildTheme({ preset: 'highContrast' });

    await render(
      <ThemeProvider preset="highContrast">
        <UiAdaptersProvider adapters={{ renderGradient }}>
          <TvScrollEdgeFade enabled showTop showBottom testID="hc-fade" />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(renderGradient).toHaveBeenCalledTimes(2);
    expect(renderGradient).toHaveBeenCalledWith(
      expect.objectContaining({
        colors: expect.arrayContaining([hc.colors.bgCanvas]),
        pointerEvents: 'none',
      }),
    );
  });

  it('supports optional surfaceColor so elevated drawers fade into their own surface token', async () => {
    const renderGradient = jest.fn(() => <View testID="grad" />);
    const theme = buildTheme();

    await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderGradient }}>
          <TvScrollEdgeFade
            enabled
            showTop
            showBottom={false}
            surfaceColor={theme.colors.bgElevated}
            testID="drawer-fade"
          />
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(renderGradient).toHaveBeenCalledTimes(1);
    expect(renderGradient).toHaveBeenCalledWith(
      expect.objectContaining({
        colors: expect.arrayContaining([theme.colors.bgElevated]),
        pointerEvents: 'none',
      }),
    );
  });
});

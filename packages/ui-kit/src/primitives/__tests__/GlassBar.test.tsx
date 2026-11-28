import { render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, Text } from 'react-native';
import { ThemeProvider } from '../../theme';
import { GlassBar } from '../GlassBar';

interface WebGlassStyle {
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
  overflow?: string;
  transitionProperty?: string;
}

describe('GlassBar web compositor safety', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies backdropFilter on scrolled web without combining overflow: hidden or transitioning backdrop-filter', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    await render(
      <ThemeProvider>
        <GlassBar scrolled testID="glass-web">
          <Text>Nav</Text>
        </GlassBar>
      </ThemeProvider>,
    );

    const style = StyleSheet.flatten(screen.getByTestId('glass-web').props.style) as WebGlassStyle;
    expect(style.backdropFilter).toBe('blur(20px)');
    expect(style.WebkitBackdropFilter).toBe('blur(20px)');
    expect(style.overflow).not.toBe('hidden');
    expect(style.transitionProperty).toBe('background-color, border-color');
    expect(style.transitionProperty).not.toContain('backdrop-filter');
  });
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { StrictMode } from 'react';
import { StyleSheet } from 'react-native';
import { ThemeProvider } from '../../theme';
import { ArtworkImage } from '../ArtworkImage';
import { createLoadedUriCache } from '../artwork-cache';
import { createDeadHostRegistry } from '../dead-host-registry';

describe('ArtworkImage React StrictMode resilience', () => {
  it('restores active URI refs on StrictMode remount so onLoad and onError still settle', async () => {
    const onLoad = jest.fn();
    const loadedUris = createLoadedUriCache();
    const deadHosts = createDeadHostRegistry();

    const view = await render(
      <StrictMode>
        <ThemeProvider>
          <ArtworkImage
            uri="https://img.example/strict-poster.jpg"
            label="Strict Poster"
            loadedUris={loadedUris}
            deadHosts={deadHosts}
            onLoad={onLoad}
            testID="strict-art"
          />
        </ThemeProvider>
      </StrictMode>,
    );

    expect(
      screen.getByTestId('strict-art-placeholder', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('strict-art-reveal').props.style).opacity).toBe(0);
    await fireEvent(screen.getByTestId('strict-art-img'), 'load');
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(loadedUris.has('https://img.example/strict-poster.jpg')).toBe(true);
    expect(
      screen.queryByTestId('strict-art-placeholder', { includeHiddenElements: true }),
    ).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('strict-art-reveal').props.style).opacity).toBe(1);
    await view.unmount();
  });
});

import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { HomeHero } from '../HomeHero';
import { HomeHeroBackdrop } from '../HomeHeroBackdrop';

describe('HomeHero decorative backdrop guard (#186)', () => {
  it('marks home-hero-backdrop as non-interactive and hidden from focus/accessibility', async () => {
    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <HomeHero
            slides={[
              {
                sourceId: 's1',
                itemKey: 'm1',
                kind: 'movie',
                title: 'Neon Horizon',
                backdropUri: 'https://img.example/home-bg.jpg',
                posterUri: null,
                rating: 8.4,
                year: 2026,
                subtitle: null,
                overview: 'A quiet frontier drama.',
                genres: ['Sci-Fi'],
                isContinueWatching: false,
                watched: false,
                positionMs: 0,
                durationMs: 0,
              },
            ]}
            activeIndex={0}
            onSelectIndex={() => undefined}
            inMyList={false}
            onPlaySlide={() => undefined}
            onToggleMyList={() => undefined}
            onToggleWatched={() => undefined}
            isTv
            isTouch={false}
            isPortrait={false}
            topClearance={64}
            minHeight={420}
            padX={48}
            focusedAction={null}
          />
        </ThemeProvider>
      </I18nProvider>,
    );
    const backdrop = screen.getByTestId('home-hero-backdrop', { includeHiddenElements: true });
    expect(backdrop.props.pointerEvents).toBe('none');
    expect(backdrop.props.accessible).toBe(false);
    expect(backdrop.props.accessibilityElementsHidden).toBe(true);
    expect(backdrop.props.importantForAccessibility).toBe('no');
    expect(
      screen.queryByTestId('home-hero-backdrop-ambient', { includeHiddenElements: true }),
    ).toBeNull();
    await view.unmount();
  });

  it('uses blurred ambient backdrop when only a vertical posterUri exists (zero poster stretch)', async () => {
    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <HomeHero
            slides={[
              {
                sourceId: 's1',
                itemKey: 'm1',
                kind: 'movie',
                title: 'Neon Horizon',
                backdropUri: null,
                posterUri: 'https://img.example/home-poster-2x3.jpg',
                rating: 8.4,
                year: 2026,
                subtitle: null,
                overview: 'A quiet frontier drama.',
                genres: ['Sci-Fi'],
                isContinueWatching: false,
                watched: false,
                positionMs: 0,
                durationMs: 0,
              },
            ]}
            activeIndex={0}
            onSelectIndex={() => undefined}
            inMyList={false}
            onPlaySlide={() => undefined}
            onToggleMyList={() => undefined}
            onToggleWatched={() => undefined}
            isTv
            isTouch={false}
            isPortrait={false}
            topClearance={64}
            minHeight={420}
            padX={48}
            focusedAction={null}
          />
        </ThemeProvider>
      </I18nProvider>,
    );
    expect(screen.queryByTestId('home-hero-backdrop', { includeHiddenElements: true })).toBeNull();
    const ambient = screen.getByTestId('home-hero-backdrop-ambient', {
      includeHiddenElements: true,
    });
    expect(ambient.props.pointerEvents).toBe('none');
    expect(ambient.props.accessible).toBe(false);
    await view.unmount();
  });

  it('keeps the previous backdrop mounted underneath until the new backdrop finishes loading (onLoad) and crossfades', async () => {
    jest.useFakeTimers();
    try {
      const view = await render(
        <ThemeProvider>
          <HomeHeroBackdrop
            slideKey="slide-a"
            uri="https://img.example/backdrop-a.jpg"
            title="Movie A"
          />
        </ThemeProvider>,
      );

      await fireEvent(
        screen.getByTestId('home-hero-backdrop-img', { includeHiddenElements: true }),
        'load',
      );
      expect(
        screen.queryByTestId('home-hero-backdrop-prev', { includeHiddenElements: true }),
      ).toBeNull();

      // Switch to Slide B: prev backdrop MUST stay mounted and new layer MUST remain hidden (opacity 0) until onLoad
      await view.rerender(
        <ThemeProvider>
          <HomeHeroBackdrop
            slideKey="slide-b"
            uri="https://img.example/backdrop-b.jpg"
            title="Movie B"
          />
        </ThemeProvider>,
      );

      expect(
        screen.getByTestId('home-hero-backdrop-prev', { includeHiddenElements: true }).props
          .accessibilityLabel,
      ).toBeUndefined();
      expect(
        screen.getByTestId('home-hero-backdrop-prev-img', { includeHiddenElements: true }).props
          .source.uri,
      ).toBe('https://img.example/backdrop-a.jpg');
      expect(
        StyleSheet.flatten(
          screen.getByTestId('home-hero-backdrop-layer', { includeHiddenElements: true }).props
            .style,
        ).opacity,
      ).toBe(0);

      // Advancing timers before Backdrop B loads must NOT unmount Backdrop A
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(
        screen.getByTestId('home-hero-backdrop-prev-img', { includeHiddenElements: true }).props
          .source.uri,
      ).toBe('https://img.example/backdrop-a.jpg');

      // Rapid switch to Slide C before B loads MUST keep Slide A underneath (not unloaded Slide B)
      await view.rerender(
        <ThemeProvider>
          <HomeHeroBackdrop
            slideKey="slide-c"
            uri="https://img.example/backdrop-c.jpg"
            title="Movie C"
          />
        </ThemeProvider>,
      );
      expect(
        screen.getByTestId('home-hero-backdrop-prev-img', { includeHiddenElements: true }).props
          .source.uri,
      ).toBe('https://img.example/backdrop-a.jpg');

      // Fire onLoad for Backdrop C -> crossfade animates and unmounts Backdrop A once complete
      await fireEvent(
        screen.getByTestId('home-hero-backdrop-img', { includeHiddenElements: true }),
        'load',
      );
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(
        screen.queryByTestId('home-hero-backdrop-prev', { includeHiddenElements: true }),
      ).toBeNull();

      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});

import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { HomeHero } from '../HomeHero';

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
});

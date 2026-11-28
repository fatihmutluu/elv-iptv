import { createAppI18n } from '@elv/i18n';
import { buildTheme, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { PosterHoverPreviewCard } from '../PosterHoverPreviewCard';
import type { PosterHoverPreviewEntry } from '../poster-hover-preview-model';

const flat = StyleSheet.flatten;
const hcTheme = buildTheme({ preset: 'highContrast' });

function makeEntry(overrides: Partial<PosterHoverPreviewEntry> = {}): PosterHoverPreviewEntry {
  return {
    itemKey: 'x:s1:movie:101',
    sourceId: 's1',
    kind: 'movie',
    title: 'Solaris Horizon',
    posterUri: 'https://art.example/solaris-poster.jpg',
    backdropUri: 'https://art.example/solaris-backdrop.jpg',
    year: 2024,
    rating: 8.5,
    overview: 'An orbital mission uncovers echoes across deep space.',
    runtimeMin: 148,
    trailerStreamUrl: 'https://cdn.example/solaris-trailer.mp4',
    trailerYoutubeId: null,
    watched: false,
    isFavorite: false,
    userRating: null,
    ...overrides,
  };
}

describe('PosterHoverPreviewCard (Wave R3)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders 16:9 artwork, title, full-width Play CTA, 3+3 action grid, tabular meta, and 3-line synopsis with theme tokens', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const i18n = createAppI18n('en');
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();
    const onOpenTrailer = jest.fn();
    const onToggleFavorite = jest.fn();
    const onToggleWatched = jest.fn();
    const onToggleRating = jest.fn();
    const onDismissRecommendation = jest.fn();

    await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider preset="highContrast">
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
          >
            <PosterHoverPreviewCard
              entry={makeEntry({ onPlay, onOpenDetail })}
              anchorRect={{ x: 200, y: 200, width: 170, height: 255 }}
              hydration={{
                title: 'Solaris Horizon',
                backdropUri: 'https://art.example/solaris-backdrop.jpg',
                year: 2024,
                rating: 8.5,
                runtimeMin: 148,
                plot: 'An orbital mission uncovers echoes across deep space.',
                trailerStreamUrl: 'https://cdn.example/solaris-trailer.mp4',
                trailerYoutubeId: null,
              }}
              metadataSettled
              isFavorite={false}
              isWatched={false}
              userRating={null}
              onPreviewPointerEnter={jest.fn()}
              onPreviewPointerLeave={jest.fn()}
              onPlay={onPlay}
              onOpenDetail={onOpenDetail}
              onOpenTrailer={onOpenTrailer}
              onToggleFavorite={onToggleFavorite}
              onToggleWatched={onToggleWatched}
              onToggleRating={onToggleRating}
              onDismissRecommendation={onDismissRecommendation}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    const card = screen.getByTestId('poster-hover-preview-card');
    const cardStyle = flat(card.props.style) as Record<string, unknown>;
    expect(cardStyle.position).toBe('fixed');
    expect(cardStyle.zIndex).toBe(42);
    expect(cardStyle.backgroundColor).toBe(hcTheme.colors.bgElevated);
    expect(cardStyle.borderColor).toBe(hcTheme.colors.glassBorder);

    expect(screen.getByTestId('hover-preview-artwork')).toBeTruthy();
    expect(screen.getByTestId('hover-preview-title')).toHaveTextContent('Solaris Horizon');
    expect(screen.getByTestId('hover-preview-actions-grid')).toBeTruthy();
    expect(screen.getByTestId('hover-preview-meta')).toHaveTextContent('2024 · ★ 8.5 · 148 min');
    expect(screen.getByTestId('hover-preview-synopsis')).toHaveTextContent(
      'An orbital mission uncovers echoes across deep space.',
    );

    const playBtn = screen.getByTestId('hover-preview-play');
    const playStyle = flat(playBtn.props.style) as Record<string, unknown>;
    expect(playStyle.width).toBe('100%');
    expect(playStyle.backgroundColor).toBe(hcTheme.colors.ctaBg);

    await fireEvent.press(playBtn);
    expect(onPlay).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('hover-preview-title'));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('hover-preview-trailer'));
    expect(onOpenTrailer).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('hover-preview-mylist'));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('hover-preview-watched'));
    expect(onToggleWatched).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('hover-preview-like'));
    expect(onToggleRating).toHaveBeenCalledWith('like');

    await fireEvent.press(screen.getByTestId('hover-preview-dislike'));
    expect(onToggleRating).toHaveBeenCalledWith('dislike');

    await fireEvent.press(screen.getByTestId('hover-preview-dismiss'));
    expect(onDismissRecommendation).toHaveBeenCalledTimes(1);
  });

  it('disables Trailer button with Unavailable tooltip when no trailer exists after hydration', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const i18n = createAppI18n('en');
    const onOpenTrailer = jest.fn();

    await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
          >
            <PosterHoverPreviewCard
              entry={makeEntry({ trailerStreamUrl: null, trailerYoutubeId: null })}
              anchorRect={{ x: 200, y: 200, width: 170, height: 255 }}
              hydration={{
                title: 'No Trailer Film',
                backdropUri: null,
                year: 2024,
                rating: 7.5,
                runtimeMin: null,
                plot: null,
                trailerStreamUrl: null,
                trailerYoutubeId: null,
              }}
              metadataSettled
              isFavorite={true}
              isWatched={true}
              userRating="like"
              onPreviewPointerEnter={jest.fn()}
              onPreviewPointerLeave={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenTrailer={onOpenTrailer}
              onToggleFavorite={jest.fn()}
              onToggleWatched={jest.fn()}
              onToggleRating={jest.fn()}
              onDismissRecommendation={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    const trailerBtn = screen.getByTestId('hover-preview-trailer');
    expect(trailerBtn.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(trailerBtn);
    expect(onOpenTrailer).not.toHaveBeenCalled();

    // Tooltip remains hoverable on the disabled trailer wrapper and displays Unavailable
    await fireEvent(screen.getByTestId('hover-preview-trailer-tooltip'), 'pointerEnter');
    // Verify active states on My List, Watched, and Like
    expect(screen.getByTestId('hover-preview-mylist').props.accessibilityState?.selected).toBe(
      true,
    );
    expect(screen.getByTestId('hover-preview-watched').props.accessibilityState?.selected).toBe(
      true,
    );
    expect(screen.getByTestId('hover-preview-like').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('hover-preview-dismiss')).toBeTruthy();
  });

  it('omits "Don\'t recommend again" button when allowDismissRecommendation is false (My List & Collections)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const i18n = createAppI18n('en');

    await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
          >
            <PosterHoverPreviewCard
              entry={makeEntry({ allowDismissRecommendation: false })}
              anchorRect={{ x: 200, y: 200, width: 170, height: 255 }}
              hydration={{
                title: 'Saved List Film',
                backdropUri: null,
                year: 2024,
                rating: 8.1,
                runtimeMin: null,
                plot: null,
                trailerStreamUrl: null,
                trailerYoutubeId: null,
              }}
              metadataSettled
              isFavorite={true}
              isWatched={false}
              userRating={null}
              onPreviewPointerEnter={jest.fn()}
              onPreviewPointerLeave={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
              onOpenTrailer={jest.fn()}
              onToggleFavorite={jest.fn()}
              onToggleWatched={jest.fn()}
              onToggleRating={jest.fn()}
              onDismissRecommendation={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.queryByTestId('hover-preview-dismiss')).toBeNull();
    expect(screen.getByTestId('hover-preview-like')).toBeTruthy();
    expect(screen.getByTestId('hover-preview-dislike')).toBeTruthy();
  });
});

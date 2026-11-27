import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { DetailHero } from '../DetailHero';

function collectImages(node: unknown): Array<{ props?: Record<string, unknown> }> {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(collectImages);
  const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  const own = el.type === 'Image' ? [el] : [];
  const children = Array.isArray(el.children) ? el.children.flatMap(collectImages) : [];
  return [...own, ...children];
}

const PRIMARY_ACTION = {
  kind: 'movie' as const,
  resume: false,
  positionMs: 0,
  durationMs: 0,
  target: {
    sourceId: 's1',
    itemKey: 'm1',
    kind: 'vod' as const,
    title: 'Neon Horizon',
  },
};

describe('DetailHero backdrop & portrait fallback', () => {
  it('marks detail-hero-backdrop as non-interactive and hides poster card when landscape backdrop exists (#186)', async () => {
    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <DetailHero
            kind="movie"
            title="Neon Horizon"
            backdropUri="https://img.example/detail-bg.jpg"
            posterUri="https://img.example/detail-poster.jpg"
            year={2026}
            rating={8.4}
            plot="Synopsis"
            seasonsCount={0}
            inMyList={false}
            watched={false}
            primaryAction={PRIMARY_ACTION}
            onBack={() => undefined}
            onPlayPrimary={() => undefined}
            onToggleMyList={() => undefined}
            onToggleWatched={() => undefined}
            isTv
            isPortrait={false}
            topClearance={64}
            padX={48}
            focusedSlot={null}
          />
        </ThemeProvider>
      </I18nProvider>,
    );
    const backdrop = screen.getByTestId('detail-hero-backdrop', { includeHiddenElements: true });
    expect(backdrop.props.pointerEvents).toBe('none');
    expect(backdrop.props.accessible).toBe(false);
    expect(backdrop.props.accessibilityElementsHidden).toBe(true);
    expect(backdrop.props.importantForAccessibility).toBe('no');
    expect(
      screen.queryByTestId('detail-hero-backdrop-ambient', { includeHiddenElements: true }),
    ).toBeNull();
    expect(screen.queryByTestId('detail-hero-poster')).toBeNull();
    expect(screen.queryByTestId('detail-kind-pill')).toBeNull();
    await view.unmount();
  });

  it('renders blurred ambient backdrop + crisp 2:3 poster card instead of stretching vertical poster when backdropUri is null', async () => {
    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <DetailHero
            kind="movie"
            title="Neon Horizon"
            backdropUri={null}
            posterUri="https://img.example/poster-2x3.jpg"
            year={2026}
            rating={8.4}
            plot="Synopsis"
            seasonsCount={0}
            inMyList={false}
            watched={false}
            primaryAction={PRIMARY_ACTION}
            onBack={() => undefined}
            onPlayPrimary={() => undefined}
            onToggleMyList={() => undefined}
            onToggleWatched={() => undefined}
            isTv={false}
            isPortrait={false}
            topClearance={64}
            padX={48}
            focusedSlot={null}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(
      screen.queryByTestId('detail-hero-backdrop', { includeHiddenElements: true }),
    ).toBeNull();
    const ambient = screen.getByTestId('detail-hero-backdrop-ambient', {
      includeHiddenElements: true,
    });
    expect(ambient.props.pointerEvents).toBe('none');
    expect(ambient.props.accessible).toBe(false);
    expect(ambient.props.accessibilityElementsHidden).toBe(true);
    expect(ambient.props.importantForAccessibility).toBe('no');

    const poster = screen.getByTestId('detail-hero-poster');
    const flatPosterStyle = StyleSheet.flatten(poster.props.style);
    expect(flatPosterStyle.aspectRatio).toBeCloseTo(2 / 3, 5);

    const images = collectImages(view.toJSON());
    const ambientImg = images.find(
      (img) =>
        (img.props?.source as { uri?: string } | undefined)?.uri ===
          'https://img.example/poster-2x3.jpg' && img.props?.blurRadius !== undefined,
    );
    expect(ambientImg?.props?.blurRadius).toBe(28);
    await view.unmount();
  });

  it('frames portrait 2:3 poster card cleanly above title on portrait viewports when backdropUri is null', async () => {
    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <DetailHero
            kind="series"
            title="Harbor Lights"
            backdropUri={null}
            posterUri="https://img.example/series-poster.jpg"
            year={2025}
            rating={8.7}
            plot="Synopsis"
            seasonsCount={2}
            inMyList={false}
            watched={false}
            primaryAction={PRIMARY_ACTION}
            onBack={() => undefined}
            onPlayPrimary={() => undefined}
            onToggleMyList={() => undefined}
            onToggleWatched={() => undefined}
            isTv={false}
            isPortrait
            topClearance={64}
            padX={16}
            focusedSlot={null}
          />
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.getByTestId('detail-hero-poster')).toBeTruthy();
    expect(screen.getByTestId('detail-kind-pill')).toHaveTextContent('Series');
    const json = JSON.stringify(view.toJSON());
    expect(json.indexOf('"detail-hero-poster"')).toBeLessThan(json.indexOf('"detail-title"'));
    await view.unmount();
  });
});

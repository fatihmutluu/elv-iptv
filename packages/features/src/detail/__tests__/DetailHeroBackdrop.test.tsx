import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { DetailHero } from '../DetailHero';

describe('DetailHero decorative backdrop guard (#186)', () => {
  it('marks detail-hero-backdrop as non-interactive and hidden from focus/accessibility', async () => {
    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <DetailHero
            kind="movie"
            title="Neon Horizon"
            backdropUri="https://img.example/detail-bg.jpg"
            year={2026}
            rating={8.4}
            plot="Synopsis"
            seasonsCount={0}
            inMyList={false}
            watched={false}
            primaryAction={{
              kind: 'movie',
              resume: false,
              positionMs: 0,
              durationMs: 0,
              target: {
                sourceId: 's1',
                itemKey: 'm1',
                kind: 'vod',
                title: 'Neon Horizon',
              },
            }}
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
    await view.unmount();
  });
});

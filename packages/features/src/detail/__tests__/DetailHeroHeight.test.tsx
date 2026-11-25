import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { computeHeroHeight } from '../../shared';
import { DetailHero } from '../DetailHero';

describe('DetailHero height', () => {
  it('matches DetailHero minHeight to computeHeroHeight for desktop and portrait viewports', async () => {
    const i18n = createAppI18n('en');
    const primaryAction = {
      kind: 'movie' as const,
      resume: false,
      positionMs: 0,
      durationMs: 0,
      target: {
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        kind: 'vod' as const,
        title: 'Cinema Test',
      },
    };

    const desktopView = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1440,
          height: 900,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={i18n}>
            <DetailHero
              kind="movie"
              title="Cinema Test"
              backdropUri={null}
              year={2026}
              rating={8.5}
              plot="A test movie."
              seasonsCount={0}
              inMyList={false}
              watched={false}
              primaryAction={primaryAction}
              onBack={jest.fn()}
              onPlayPrimary={jest.fn()}
              onToggleMyList={jest.fn()}
              onToggleWatched={jest.fn()}
              isTv={false}
              isPortrait={false}
              topClearance={80}
              padX={24}
              focusedSlot={null}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const desktopHeroStyle = StyleSheet.flatten(screen.getByTestId('detail-hero').props.style);
    expect(desktopHeroStyle.minHeight).toBe(computeHeroHeight(900, false, false, true));
    await desktopView.unmount();

    const portraitView = await render(
      <ViewportProvider
        value={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={i18n}>
            <DetailHero
              kind="movie"
              title="Cinema Test"
              backdropUri={null}
              year={2026}
              rating={8.5}
              plot="A test movie."
              seasonsCount={0}
              inMyList={false}
              watched={false}
              primaryAction={primaryAction}
              onBack={jest.fn()}
              onPlayPrimary={jest.fn()}
              onToggleMyList={jest.fn()}
              onToggleWatched={jest.fn()}
              isTv={false}
              isPortrait
              topClearance={64}
              padX={16}
              focusedSlot={null}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const portraitHeroStyle = StyleSheet.flatten(screen.getByTestId('detail-hero').props.style);
    expect(portraitHeroStyle.minHeight).toBe(computeHeroHeight(844, true, false, true));
    await portraitView.unmount();
  });
});

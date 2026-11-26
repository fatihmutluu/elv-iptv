import type { EpisodeRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StreamHealthProvider } from '../../shared';
import { DetailEpisodeRow } from '../DetailEpisodeRow';
import { DetailHero } from '../DetailHero';

async function wrapUi(node: ReactElement) {
  const i18n = createAppI18n('en');
  return render(
    <ViewportProvider
      value={{
        width: 1280,
        height: 720,
        formFactor: 'desktop',
        inputModality: 'pointer',
      }}
    >
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <StreamHealthProvider>{node}</StreamHealthProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>,
  );
}

describe('Detail download CTAs', () => {
  it('renders DetailHero download button for movies and invokes onPressDownload', async () => {
    const onPressDownload = jest.fn();
    await wrapUi(
      <DetailHero
        kind="movie"
        title="Arrival"
        backdropUri={null}
        year={2016}
        rating={7.9}
        plot="Sci-fi"
        seasonsCount={0}
        inMyList={false}
        watched={false}
        primaryAction={{
          kind: 'movie',
          resume: false,
          positionMs: 0,
          durationMs: 0,
          target: {
            itemKey: 'movie:s1:1',
            sourceId: 's1',
            title: 'Arrival',
            kind: 'vod',
          },
        }}
        downloadState={{ icon: 'download', active: false, label: 'Download' }}
        onPressDownload={onPressDownload}
        onBack={jest.fn()}
        onPlayPrimary={jest.fn()}
        onToggleMyList={jest.fn()}
        onToggleWatched={jest.fn()}
        isTv={false}
        isPortrait={false}
        topClearance={0}
        padX={24}
        focusedSlot={null}
      />,
    );

    await fireEvent.press(screen.getByTestId('detail-download'));
    expect(onPressDownload).toHaveBeenCalledTimes(1);
  });

  it('renders trailing episode download button and calls onPressDownload without playing episode', async () => {
    const episode: EpisodeRow = {
      id: 1,
      key: 'ep:s1:1',
      season: 1,
      episode: 1,
      title: 'Pilot',
      durationSec: 2400,
    };
    const onPressEpisode = jest.fn();
    const onPressDownload = jest.fn();

    await wrapUi(
      <DetailEpisodeRow
        episode={episode}
        index={0}
        progress={undefined}
        seriesBackdropUri={null}
        isTv={false}
        isPortrait={false}
        focused={false}
        watchedLabel="Watched"
        onPressEpisode={onPressEpisode}
        downloadsSupported
        onPressDownload={onPressDownload}
      />,
    );

    await fireEvent.press(screen.getByTestId('detail-episode-0-download'), {
      stopPropagation: jest.fn(),
    });
    expect(onPressDownload).toHaveBeenCalledWith(episode);
    expect(onPressEpisode).not.toHaveBeenCalled();
  });
});

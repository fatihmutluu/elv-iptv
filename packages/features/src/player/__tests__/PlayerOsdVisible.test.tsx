import type { CatalogService } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { render } from '@testing-library/react-native';
import { View } from 'react-native';
import type { VideoHost, VideoSurfaceProps } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';

describe('PlayerScreen osdVisible prop forwarding (#442)', () => {
  it('forwards osdVisible true/false to VideoHost.renderSurface', async () => {
    const engine = createFakePlayerEngine({
      now: () => 0,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const observedSurfaceProps: VideoSurfaceProps[] = [];
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: (props) => {
          observedSurfaceProps.push(props);
          return <View testID={props.testID ?? 'player-surface'} />;
        },
      }),
    };
    const catalog: Pick<CatalogService, 'resolveStream' | 'getProgress' | 'saveProgress'> = {
      resolveStream: async () => ({
        ok: true as const,
        value: { url: 'http://sim/movie/demo/demo/1.mp4', headers: {} },
      }),
      getProgress: async () => null,
      saveProgress: async () => ({
        ok: true as const,
        value: {
          profileId: 'default',
          sourceId: 'src-1',
          itemKey: 'vod-1',
          kind: 'movie',
          title: 'Sample Movie',
          subtitle: null,
          logo: null,
          seriesKey: null,
          season: null,
          episode: null,
          positionMs: 0,
          durationMs: 0,
          watched: false,
          updatedAt: 0,
        },
      }),
    };

    const visibleView = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              target={{
                sourceId: 'src-1',
                accountKey: 'acc-1',
                itemKey: 'vod-1',
                kind: 'vod',
                title: 'Sample Movie',
              }}
              onExit={() => undefined}
            />
          </ThemeProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );
    expect(observedSurfaceProps[observedSurfaceProps.length - 1]?.osdVisible).toBe(true);
    await visibleView.unmount();

    observedSurfaceProps.length = 0;
    const hiddenView = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <PlayerScreen
              catalog={catalog}
              videoHost={videoHost}
              initialOsdHidden
              target={{
                sourceId: 'src-1',
                accountKey: 'acc-1',
                itemKey: 'vod-1',
                kind: 'vod',
                title: 'Sample Movie',
              }}
              onExit={() => undefined}
            />
          </ThemeProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );
    expect(observedSurfaceProps[observedSurfaceProps.length - 1]?.osdVisible).toBe(false);
    await hiddenView.unmount();
  });
});

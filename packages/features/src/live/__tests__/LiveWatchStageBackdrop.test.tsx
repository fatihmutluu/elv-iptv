import type { ItemRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, resolveViewport, ThemeProvider, useTheme } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { computeCatalogLayout } from '../../shared';
import { LiveWatchStage } from '../LiveWatchStage';

function StageHarness({ channel, isDesktop }: { channel: ItemRow; isDesktop: boolean }) {
  const theme = useTheme();
  const layout = computeCatalogLayout(
    resolveViewport({ isTV: true, os: 'ios', width: 1920, height: 1080 }),
    theme,
  );
  return (
    <LiveWatchStage
      activeChannel={channel}
      activeChannelIndex={0}
      channelSource={null}
      sourceVersion={0}
      nowNextByKey={new Map()}
      nowNextVersion={0}
      zapDrawerOpen={false}
      isDesktop={isDesktop}
      layout={layout}
      hydrateNowNext={() => undefined}
      onToggleZapDrawer={() => undefined}
      onSelectChannel={() => undefined}
      onWatchFullscreen={() => undefined}
    />
  );
}

describe('LiveWatchStage decorative backdrop guard (#186)', () => {
  it('marks live-stage-backdrop as non-interactive in both TV/mobile and desktop layouts', async () => {
    const channel: ItemRow = {
      id: 1,
      key: 'live:s1:ch-1',
      sourceId: 's1',
      kind: 'live',
      providerId: '101',
      name: 'News 24',
      logo: 'https://img.example/ch1.png',
      num: 1,
      year: null,
      rating: null,
    };

    for (const isDesktop of [false, true]) {
      const view = await render(
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <StageHarness channel={channel} isDesktop={isDesktop} />
          </ThemeProvider>
        </I18nProvider>,
      );
      const backdrop = screen.getByTestId('live-stage-backdrop', { includeHiddenElements: true });
      expect(backdrop.props.pointerEvents).toBe('none');
      expect(backdrop.props.accessible).toBe(false);
      expect(backdrop.props.accessibilityElementsHidden).toBe(true);
      expect(backdrop.props.importantForAccessibility).toBe('no');
      await view.unmount();
    }
  });
});

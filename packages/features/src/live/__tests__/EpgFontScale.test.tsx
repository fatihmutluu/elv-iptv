import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';
import { EpgTimeRuler } from '../EpgPreviewHeader';

describe('EPG fontScale scaling (#62)', () => {
  it('scales EpgTimeRuler height deterministically at fontScale = 1.2', async () => {
    const view = await render(
      <ViewportProvider
        value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider fontScale={1.2}>
            <EpgTimeRuler
              categoryLabel="News"
              rulerTicks={[0, 1_800_000]}
              channelColWidth={200}
              isTv
              isPortrait={false}
              jumpHighlighted={false}
              nowMs={900_000}
              nowLineRatio={0.25}
              onPanEarlier={jest.fn()}
              onJumpToLive={jest.fn()}
              onPanLater={jest.fn()}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    const rulerStyle = (StyleSheet.flatten(screen.getByTestId('epg-time-ruler').props.style) ??
      {}) as ViewStyle;
    expect(rulerStyle.height).toBe(Math.round(32 * 1.2));
    const badgeStyle = (StyleSheet.flatten(
      screen.getByTestId('epg-live-clock-badge').props.style,
    ) ?? {}) as ViewStyle;
    expect(badgeStyle.width).toBe(Math.round(52 * 1.2));
    expect(badgeStyle.height).toBe(Math.round(22 * 1.2));
    await view.unmount();
  });
});

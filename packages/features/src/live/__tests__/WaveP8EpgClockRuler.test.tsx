import type { CatalogService, CategoryRow, ItemRow, ProgrammeRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { buildTheme, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';
import { createPagedListSource, type DisplayCategory } from '../../shared';
import { EpgGridView } from '../EpgGridView';
import { EpgTimeRuler } from '../EpgPreviewHeader';
import {
  buildEpgRulerTicks,
  EPG_VISIBLE_SPAN_MS,
  formatClockTime,
  LIVE_MAX_PAGES,
  LIVE_PAGE_SIZE,
} from '../live-model';

const MIN = 60_000;
const BASE_MS = Date.UTC(2026, 10, 21, 18, 0, 0);

function makeCategory(): DisplayCategory {
  const row: CategoryRow = {
    id: 'src-1|live|all',
    sourceId: 'src-1',
    kind: 'live',
    name: 'All Channels',
    position: 0,
    itemCount: 1,
  };
  return { row, label: 'All Channels' };
}

function makeChannel(): ItemRow {
  return {
    id: 1,
    key: 'x:src-1:live:1',
    kind: 'live',
    sourceId: 'src-1',
    providerId: '1',
    name: 'News HD',
    logo: null,
    rating: null,
    year: null,
    num: 101,
  };
}

function flatViewStyle(testID: string): ViewStyle {
  return (StyleSheet.flatten(screen.getByTestId(testID).props.style) ?? {}) as ViewStyle;
}

function flatTextStyle(testID: string): TextStyle {
  return (StyleSheet.flatten(
    screen.getByTestId(testID, { includeHiddenElements: true }).props.style,
  ) ?? {}) as TextStyle;
}

describe('Wave P8 EPG Live Clock Pill Anchored on Time-Ruler Now-Line (#507 [1.26])', () => {
  it('removes top-left clock from timeNavBar and anchors epg-live-clock-badge inside epg-ruler-track centered over now-line', async () => {
    const ch0 = makeChannel();
    const channelSource = createPagedListSource<ItemRow>({
      count: 1,
      pageSize: LIVE_PAGE_SIZE,
      maxPages: LIVE_MAX_PAGES,
      loadPage: async () => [ch0],
    });
    const catalog = {
      epgWindow: jest.fn(async () => ({
        [ch0.key]: [
          {
            channelKey: ch0.key,
            sourceId: 'src-1',
            guideId: 'g-1',
            start: BASE_MS,
            stop: BASE_MS + 60 * MIN,
            title: 'Evening News',
            subTitle: null,
            description: null,
            episodeNum: null,
            icon: null,
            genre: null,
            flags: 0,
          } satisfies ProgrammeRow,
        ],
      })),
    } as unknown as CatalogService;

    const nowMs = BASE_MS + 45 * MIN;
    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <EpgGridView
              catalog={catalog}
              category={makeCategory()}
              channelSource={channelSource}
              sourceVersion={0}
              refreshToken={1}
              nowMs={nowMs}
              epgShowClock={true}
              onWatchChannel={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('epg-ruler-track')).toBeTruthy();
      expect(screen.getByTestId('epg-now-line')).toBeTruthy();
    });

    // Top-left nav bar must NOT contain epg-live-clock anymore
    const navBar = screen.getByTestId('epg-time-nav-bar');
    expect(within(navBar).queryByTestId('epg-live-clock')).toBeNull();

    // Live clock pill is anchored directly inside epg-ruler-track
    const track = screen.getByTestId('epg-ruler-track');
    const badge = within(track).getByTestId('epg-live-clock-badge');
    const clockText = within(badge).getByTestId('epg-live-clock');
    expect(clockText).toHaveTextContent(formatClockTime(nowMs));
    expect(badge.props.pointerEvents).toBe('none');

    // Measure ruler track width via onLayout (600px): windowStartMs floors to 18:30 so 18:45 is +15m -> ratio = 15/180 = 1/12 -> center 50 -> left = 50 - 26 = 24
    await fireEvent(track, 'layout', { nativeEvent: { layout: { width: 600, height: 32 } } });
    const theme = buildTheme({ preset: 'obsidianCrimson' });
    expect(flatViewStyle('epg-live-clock-badge')).toMatchObject({
      left: 24,
      width: 52,
      direction: 'ltr',
      backgroundColor: theme.colors.accent,
    });
    expect(flatTextStyle('epg-live-clock')).toMatchObject({
      color: theme.colors.accentContrast,
      fontVariant: ['tabular-nums'],
    });

    // Panning off-live hides both epg-now-line and epg-live-clock-badge
    await fireEvent.press(screen.getByTestId('epg-pan-later'));
    await waitFor(() => {
      expect(screen.queryByTestId('epg-now-line')).toBeNull();
      expect(screen.queryByTestId('epg-live-clock-badge')).toBeNull();
      expect(screen.queryByTestId('epg-live-clock')).toBeNull();
    });

    channelSource.dispose();
    await view.unmount();
  });

  it('hides colliding ticks at :00 and :30, clamps cleanly at 0% and 100%, and keeps all ticks visible when showClock is false', async () => {
    const ticks = buildEpgRulerTicks(BASE_MS, EPG_VISIBLE_SPAN_MS); // 6 × 30m ticks

    const renderRuler = (props: {
      nowMs: number;
      nowLineRatio: number | null;
      showClock?: boolean;
      fontScale?: number;
      preset?: 'obsidianCrimson' | 'highContrast';
    }) => (
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
      >
        <ThemeProvider preset={props.preset ?? 'obsidianCrimson'} fontScale={props.fontScale ?? 1}>
          <I18nProvider i18n={createAppI18n('en')}>
            <EpgTimeRuler
              categoryLabel="News"
              rulerTicks={ticks}
              channelColWidth={176}
              isTv={false}
              isPortrait={false}
              jumpHighlighted={false}
              showClock={props.showClock ?? true}
              nowMs={props.nowMs}
              nowLineRatio={props.nowLineRatio}
              onPanEarlier={jest.fn()}
              onJumpToLive={jest.fn()}
              onPanLater={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    // At :00 (ratio = 0): clamped to left = 0, hides epg-tick-0, leaves epg-tick-1..5 visible
    const view = await render(renderRuler({ nowMs: BASE_MS, nowLineRatio: 0 }));
    await fireEvent(screen.getByTestId('epg-ruler-track'), 'layout', {
      nativeEvent: { layout: { width: 600, height: 32 } },
    });
    expect(flatViewStyle('epg-live-clock-badge').left).toBe(0);
    expect(flatTextStyle('epg-tick-0').opacity).toBe(0);
    expect(flatTextStyle('epg-tick-1').opacity).toBeUndefined();

    // At :30 (ratio = 1/6): centered over tick 1, hides epg-tick-1, restores epg-tick-0
    await view.rerender(renderRuler({ nowMs: BASE_MS + 30 * MIN, nowLineRatio: 1 / 6 }));
    expect(flatViewStyle('epg-live-clock-badge').left).toBe(74);
    expect(flatTextStyle('epg-tick-0').opacity).toBeUndefined();
    expect(flatTextStyle('epg-tick-1').opacity).toBe(0);
    expect(flatTextStyle('epg-tick-2').opacity).toBeUndefined();

    // At 100% right edge (ratio = 1): clamped to trackWidth - pillWidth = 600 - 52 = 548
    await view.rerender(renderRuler({ nowMs: BASE_MS + 180 * MIN, nowLineRatio: 1 }));
    expect(flatViewStyle('epg-live-clock-badge').left).toBe(548);

    // showClock=false: hides badge completely and keeps ALL ticks visible even at :30!
    await view.rerender(
      renderRuler({ nowMs: BASE_MS + 30 * MIN, nowLineRatio: 1 / 6, showClock: false }),
    );
    expect(screen.queryByTestId('epg-live-clock-badge')).toBeNull();
    expect(screen.queryByTestId('epg-live-clock')).toBeNull();
    for (let i = 0; i < ticks.length; i += 1) {
      expect(flatTextStyle(`epg-tick-${i}`).opacity).toBeUndefined();
    }

    // fontScale=1.2 + High Contrast AAA tokens
    await view.rerender(
      renderRuler({
        nowMs: BASE_MS + 30 * MIN,
        nowLineRatio: 1 / 6,
        showClock: true,
        fontScale: 1.2,
        preset: 'highContrast',
      }),
    );
    const aaaTheme = buildTheme({ preset: 'highContrast', fontScale: 1.2 });
    expect(flatViewStyle('epg-live-clock-badge')).toMatchObject({
      width: Math.round(52 * 1.2),
      height: Math.round(22 * 1.2),
      backgroundColor: aaaTheme.colors.accent,
    });
    expect(flatTextStyle('epg-live-clock').color).toBe(aaaTheme.colors.accentContrast);

    await view.unmount();

    // Narrow portrait viewport (< 360px track) uses Math.max(160, viewportWidth - channelColWidth) without 360 floor
    const narrowView = await render(
      <ViewportProvider
        value={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 320,
          height: 640,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <EpgTimeRuler
              categoryLabel="News"
              rulerTicks={ticks}
              channelColWidth={120}
              isTv={false}
              isPortrait
              jumpHighlighted={false}
              showClock
              nowMs={BASE_MS + 180 * MIN}
              nowLineRatio={1}
              onPanEarlier={jest.fn()}
              onJumpToLive={jest.fn()}
              onPanLater={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );
    // Track fallback is 320 - 120 = 200 -> right-edge clamped left = 200 - 52 = 148 (NOT 360 - 52 = 308)
    expect(flatViewStyle('epg-live-clock-badge').left).toBe(148);
    await narrowView.unmount();
  });
});

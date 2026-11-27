import type { CatalogService, CategoryRow, ItemRow, ProgrammeRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { createPagedListSource, type DisplayCategory } from '../../shared';
import { EpgGridView } from '../EpgGridView';
import { LIVE_MAX_PAGES, LIVE_PAGE_SIZE } from '../live-model';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;

const MIN = 60_000;
const BASE_MS = Date.UTC(2026, 10, 21, 18, 0, 0);
const NOW_MS = BASE_MS + 15 * MIN;
const TV_VIEWPORT: ViewportOverride = {
  formFactor: 'tv',
  orientation: 'landscape',
  inputModality: 'tv',
  width: 1280,
  height: 720,
};

function makeChannel(index: number): ItemRow {
  return {
    id: index + 1,
    key: `x:src-1:live:${index + 1}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(index + 1),
    name: `Channel ${index + 1}`,
    logo: null,
    rating: null,
    year: null,
    num: 100 + index + 1,
  };
}

function makeProgramme(
  channelKey: string,
  startMin: number,
  stopMin: number,
  title: string,
): ProgrammeRow {
  return {
    channelKey,
    sourceId: 'src-1',
    guideId: `g-${channelKey}`,
    start: BASE_MS + startMin * MIN,
    stop: BASE_MS + stopMin * MIN,
    title,
    subTitle: null,
    description: `Synopsis for ${title}`,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  };
}

function makeCategory(itemCount: number): DisplayCategory {
  const row: CategoryRow = {
    id: 'src-1|live|all',
    sourceId: 'src-1',
    kind: 'live',
    name: 'All Channels',
    position: 0,
    itemCount,
  };
  return { row, label: 'All Channels' };
}

function createAndroidSource() {
  let listener: ((event: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(cb) {
      listener = cb;
      return {
        remove() {
          listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
    });
  };
  return { source, sendKey };
}

describe('EpgGridView time-overlap vertical navigation (#112) and RTL-safe timelines (#130)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('selects maximum overlapping programme on vertical D-pad moves and preserves anchorMs across empty rows (#112)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const channels = [makeChannel(0), makeChannel(1), makeChannel(2), makeChannel(3)];
    const [ch0, ch1, ch2] = channels as [ItemRow, ItemRow, ItemRow, ItemRow];
    const channelSource = createPagedListSource<ItemRow>({
      count: channels.length,
      pageSize: LIVE_PAGE_SIZE,
      maxPages: LIVE_MAX_PAGES,
      loadPage: async (offset, limit) => channels.slice(offset, offset + limit),
    });

    const catalog = {
      epgWindow: jest.fn(async (keys: readonly string[]) => {
        const out: Record<string, ProgrammeRow[]> = {};
        for (const key of keys) {
          if (key === ch0.key) {
            // Row 0: 2-hour movie [18:00, 20:00]
            out[key] = [
              makeProgramme(key, 0, 120, 'Two Hour Feature'),
              makeProgramme(key, 120, 180, 'Late Wrap'),
            ];
          } else if (key === ch1.key) {
            // Row 1: 30m News [18:00, 18:30] + 90m Drama [18:30, 20:00]
            // anchorMs is 18:15 (inside News), but 2h Movie overlaps Drama by 90m vs News by 30m!
            out[key] = [
              makeProgramme(key, 0, 30, 'Short News'),
              makeProgramme(key, 30, 120, 'Ninety Min Drama'),
              makeProgramme(key, 120, 180, 'Night Talk'),
            ];
          } else if (key === ch2.key) {
            // Row 2: empty schedule gap
            out[key] = [];
          } else {
            // Row 3: 30m [18:00, 18:30], 90m [18:30, 20:00], 60m [20:00, 21:00]
            out[key] = [
              makeProgramme(key, 0, 30, 'Ch4 Early'),
              makeProgramme(key, 30, 120, 'Ch4 Main'),
              makeProgramme(key, 120, 180, 'Ch4 Late'),
            ];
          }
        }
        return out;
      }),
    } as unknown as CatalogService;

    const { source: androidSource, sendKey } = createAndroidSource();
    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider value={TV_VIEWPORT}>
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <EpgGridView
                catalog={catalog}
                category={makeCategory(channels.length)}
                channelSource={channelSource}
                sourceVersion={0}
                refreshToken={1}
                nowMs={NOW_MS}
                onWatchChannel={jest.fn()}
                isActiveScope
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Synopsis for Two Hour Feature')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-1-1')).toBeTruthy();
    });

    // Moving Down from 2h movie [18:00-20:00] to Row 1 MUST pick 90m Drama [18:30-20:00] (slot 1),
    // NOT 30m News [18:00-18:30] even though initial anchorMs = 18:15!
    await sendKey(KEYCODE_DPAD_DOWN);
    await waitFor(() => {
      expect(screen.getByText('Synopsis for Ninety Min Drama')).toBeTruthy();
    });
    expect(screen.getByTestId('epg-cell-1-1').props.accessibilityState?.selected).toBe(true);

    // Step Right to Night Talk [20:00-21:00] (updates anchorMs to 20:30), then move Down across empty Row 2 -> Row 3
    await sendKey(KEYCODE_DPAD_RIGHT);
    await waitFor(() => {
      expect(screen.getByText('Synopsis for Night Talk')).toBeTruthy();
    });

    // Row 2 has no guide data (empty channel row)
    await sendKey(KEYCODE_DPAD_DOWN);
    await waitFor(() => {
      expect(screen.getByTestId('epg-cell-2-0').props.accessibilityState?.selected).toBe(true);
    });

    // Moving Down from empty Row 2 into Row 3 falls back to preserved anchorMs (20:30) -> Ch4 Late (slot 2)!
    await sendKey(KEYCODE_DPAD_DOWN);
    await waitFor(() => {
      expect(screen.getByText('Synopsis for Ch4 Late')).toBeTruthy();
    });
    expect(screen.getByTestId('epg-cell-3-2').props.accessibilityState?.selected).toBe(true);

    channelSource.dispose();
    await view.unmount();
  });

  it('forces direction: ltr on EPG timeline ruler, channel row track, and live progress bar (#130)', async () => {
    const ch0 = makeChannel(0);
    const channelSource = createPagedListSource<ItemRow>({
      count: 1,
      pageSize: LIVE_PAGE_SIZE,
      maxPages: LIVE_MAX_PAGES,
      loadPage: async () => [ch0],
    });
    const catalog = {
      epgWindow: jest.fn(async () => ({
        [ch0.key]: [makeProgramme(ch0.key, 0, 60, 'Evening News')],
      })),
    } as unknown as CatalogService;

    const view = await render(
      <ViewportProvider value={TV_VIEWPORT}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <EpgGridView
              catalog={catalog}
              category={makeCategory(1)}
              channelSource={channelSource}
              sourceVersion={0}
              refreshToken={1}
              nowMs={NOW_MS}
              onWatchChannel={jest.fn()}
              isActiveScope
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('epg-cell-progress-0-0')).toBeTruthy();
    });

    const rulerStyle = StyleSheet.flatten(screen.getByTestId('epg-time-ruler').props.style);
    expect(rulerStyle.direction).toBe('ltr');

    const rulerTrackStyle = StyleSheet.flatten(screen.getByTestId('epg-ruler-track').props.style);
    expect(rulerTrackStyle.direction).toBe('ltr');

    const clockBadgeStyle = StyleSheet.flatten(
      screen.getByTestId('epg-live-clock-badge').props.style,
    );
    expect(clockBadgeStyle.direction).toBe('ltr');

    const rowTrackStyle = StyleSheet.flatten(screen.getByTestId('epg-row-track-0').props.style);
    expect(rowTrackStyle.direction).toBe('ltr');

    const progressTrackStyle = StyleSheet.flatten(
      screen.getByTestId('epg-cell-progress-track-0-0').props.style,
    );
    expect(progressTrackStyle.direction).toBe('ltr');

    channelSource.dispose();
    await view.unmount();
  });
});

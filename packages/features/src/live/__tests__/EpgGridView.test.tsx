import {
  type CatalogService,
  type CategoryRow,
  type ItemRow,
  MAX_EPG_WINDOW_KEYS,
  type ProgrammeRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  buildTheme,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, VirtualizedList } from 'react-native';
import { createPagedListSource, type DisplayCategory } from '../../shared';
import { EpgGridView, type EpgGridViewProps } from '../EpgGridView';
import {
  EPG_PAN_STEP_MS,
  EPG_VISIBLE_SPAN_MS,
  formatClockTime,
  LIVE_MAX_PAGES,
  LIVE_PAGE_SIZE,
} from '../live-model';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const HOUR = 3_600_000;
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

function makeLiveSource(channels: readonly ItemRow[]) {
  return createPagedListSource<ItemRow>({
    count: channels.length,
    pageSize: LIVE_PAGE_SIZE,
    maxPages: LIVE_MAX_PAGES,
    loadPage: async (offset, limit) => channels.slice(offset, offset + limit),
  });
}

function makeDynamicSource(count: number) {
  const loadPage = jest.fn(async (offset: number, limit: number) => {
    const end = Math.min(count, offset + limit);
    const rows: ItemRow[] = [];
    for (let i = offset; i < end; i++) rows.push(makeLiveChannel(i));
    return rows;
  });
  const channelSource = createPagedListSource<ItemRow>({
    count,
    pageSize: LIVE_PAGE_SIZE,
    maxPages: LIVE_MAX_PAGES,
    loadPage,
  });
  return { channelSource, loadPage };
}

function makeLiveCategory(itemCount: number): DisplayCategory {
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

function makeLiveChannel(index: number): ItemRow {
  return {
    id: index + 1,
    key: `x:src-1:live:${index + 1}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(index + 1),
    name: `Channel ${index + 1}`,
    logo: `https://logos.example.test/ch-${index + 1}.png`,
    rating: null,
    year: null,
    num: 100 + index + 1,
  };
}

function makeProgramme(
  channelKey: string,
  startOffsetMin: number,
  stopOffsetMin: number,
  title: string,
  description: string | null = `Synopsis for ${title}`,
): ProgrammeRow {
  return {
    channelKey,
    sourceId: 'src-1',
    guideId: `guide-${channelKey}`,
    start: BASE_MS + startOffsetMin * MIN,
    stop: BASE_MS + stopOffsetMin * MIN,
    title,
    subTitle: null,
    description,
    episodeNum: null,
    icon: null,
  };
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

interface EpgMockOptions {
  readonly programmesByChannel: (
    channelKey: string,
    fromMs: number,
    toMs: number,
  ) => ProgrammeRow[];
  readonly onImportGuide?: () => Promise<void>;
}

function createMockEpgCatalog(opts: EpgMockOptions) {
  const epgWindowCalls: Array<{ keys: readonly string[]; fromMs: number; toMs: number }> = [];
  const importGuideCalls: string[] = [];

  const catalog = {
    epgWindow: jest.fn(async (channelKeys: readonly string[], fromMs: number, toMs: number) => {
      epgWindowCalls.push({ keys: [...channelKeys], fromMs, toMs });
      const out: Record<string, ProgrammeRow[]> = {};
      for (const key of channelKeys) {
        out[key] = opts.programmesByChannel(key, fromMs, toMs);
      }
      return out;
    }),
    importGuide: jest.fn(async (sourceId: string) => {
      importGuideCalls.push(sourceId);
      await opts.onImportGuide?.();
      return ok({
        sourceId,
        kind: 'guide' as const,
        categories: 0,
        live: 0,
        movies: 0,
        series: 0,
        episodes: 0,
        guideChannels: 10,
        programmes: 100,
        durationMs: 25,
      });
    }),
  } as unknown as CatalogService;

  return { catalog, epgWindowCalls, importGuideCalls };
}

function buildEpgTree(
  props: Omit<EpgGridViewProps, 'nowMs'> & { nowMs?: number | 'live' },
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    androidSource?: AndroidKeySource;
  } = {},
) {
  const { nowMs, ...rest } = props;
  const resolvedNow = nowMs === 'live' ? undefined : (nowMs ?? NOW_MS);
  const tree = (
    <ViewportProvider
      value={
        opts.viewport ?? {
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }
      }
    >
      <ThemeProvider preset={opts.preset ?? 'obsidianCrimson'}>
        <I18nProvider i18n={createAppI18n('en')}>
          <EpgGridView {...rest} {...(resolvedNow !== undefined ? { nowMs: resolvedNow } : {})} />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  return opts.androidSource ? (
    <RemoteKeysProvider android={opts.androidSource}>{tree}</RemoteKeysProvider>
  ) : (
    tree
  );
}

function renderEpg(
  props: Omit<EpgGridViewProps, 'nowMs'> & { nowMs?: number | 'live' },
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    androidSource?: AndroidKeySource;
  } = {},
) {
  return render(buildEpgTree(props, opts));
}

describe('EpgGridView — Cinema Quietude Virtualized XMLTV EPG Grid', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders EpgPreviewHeader, Time Ruler ticks, vertical Now line, and live programme progress bar', async () => {
    const channels = [makeLiveChannel(0), makeLiveChannel(1)];
    const ch0 = channels[0] as ItemRow;
    const channelSource = makeLiveSource(channels);

    const { catalog } = createMockEpgCatalog({
      programmesByChannel: (key) =>
        key === ch0.key
          ? [
              makeProgramme(key, 0, 60, 'Evening News', 'Live breaking headlines.'),
              makeProgramme(key, 60, 120, 'Prime Documentary', 'Deep sea worlds.'),
            ]
          : [makeProgramme(key, 0, 90, 'Stadium Live', 'Championship kickoff.')],
    });

    const view = await renderEpg({
      catalog,
      category: makeLiveCategory(channels.length),
      channelSource,
      sourceVersion: 0,
      refreshToken: 1,
      onWatchChannel: jest.fn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
      expect(screen.getByTestId('epg-preview-header')).toBeTruthy();
      expect(screen.getByTestId('epg-time-ruler')).toBeTruthy();
      expect(screen.getByTestId('epg-matrix')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy();
    });

    // Preview header shows focused live programme, ON AIR badge, and synopsis
    expect(screen.getAllByText('Evening News').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Live breaking headlines.')).toBeTruthy();
    expect(screen.getByTestId('epg-preview-on-air')).toBeTruthy();
    expect(screen.getByTestId('epg-preview-live-pill')).toBeTruthy();

    // Time ruler renders 6 × 30m ticks starting at BASE_MS
    expect(screen.getByTestId('epg-tick-0').props.children).toBe(formatClockTime(BASE_MS));
    expect(screen.getByTestId('epg-tick-5')).toBeTruthy();

    // Vertical Now accent line is positioned at (15m / 180m) * 100%
    const nowLine = screen.getByTestId('epg-now-line');
    const nowLineStyle = StyleSheet.flatten(nowLine.props.style);
    const defaultTheme = buildTheme({ preset: 'obsidianCrimson' });
    expect(nowLineStyle.backgroundColor).toBe(defaultTheme.colors.accent);
    expect(nowLineStyle.left).toBe(`${((NOW_MS - BASE_MS) / EPG_VISIBLE_SPAN_MS) * 100}%`);

    // Live cell renders progress bar fill with accent color
    const progressFill = screen.getByTestId('epg-cell-progress-0-0');
    const progressStyle = StyleSheet.flatten(progressFill.props.style);
    expect(progressStyle.backgroundColor).toBe(defaultTheme.colors.accent);

    channelSource.dispose();
    await view.unmount();
  });

  it('keeps 1,000-channel × 7-day EPG strictly O(1): bounded page load, <= 40 EPG keys per call, and <= 14 mounted rows', async () => {
    const TOTAL_CHANNELS = 1_000;
    const { channelSource, loadPage } = makeDynamicSource(TOTAL_CHANNELS);

    // Synthetic 7-day schedule generator filtered to requested [fromMs, toMs]
    const { catalog, epgWindowCalls } = createMockEpgCatalog({
      programmesByChannel: (key, fromMs, toMs) => {
        const out: ProgrammeRow[] = [];
        const firstHour = Math.floor((fromMs - BASE_MS) / HOUR);
        const lastHour = Math.ceil((toMs - BASE_MS) / HOUR);
        for (let h = firstHour; h < lastHour; h++) {
          out.push(makeProgramme(key, h * 60, (h + 1) * 60, `Show H${h}`));
        }
        return out;
      },
    });

    const view = await renderEpg(
      {
        catalog,
        category: makeLiveCategory(TOTAL_CHANNELS),
        channelSource,
        sourceVersion: 0,
        refreshToken: 1,
        onWatchChannel: jest.fn(),
      },
      { viewport: TV_VIEWPORT },
    );

    await waitFor(() => {
      expect(screen.getByTestId('epg-tv-viewport')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy();
    });

    // Only initial bounded channel page loaded (never 1,000 items materialized)
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith(0, LIVE_PAGE_SIZE);

    // EPG queries strictly bounded to visible window keys (<= MAX_EPG_WINDOW_KEYS = 40)
    expect(epgWindowCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of epgWindowCalls) {
      expect(call.keys.length).toBeLessThanOrEqual(MAX_EPG_WINDOW_KEYS);
      expect(call.keys.length).toBeLessThanOrEqual(14);
    }

    // Strictly <= 14 channel rows mounted in the tree even for 1,000 channels
    const mountedRows = screen.getAllByTestId(/^epg-row-\d+$/);
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThanOrEqual(14);

    channelSource.dispose();
    await view.unmount();
  });

  it('preserves 10-ft TV 2D D-pad anchorTimeMs across channels, tunes on Select, and calls onEdgeTop at row 0', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const channels = [makeLiveChannel(0), makeLiveChannel(1)];
    const [ch0, ch1] = channels as [ItemRow, ItemRow];
    const channelSource = makeLiveSource(channels);

    const { catalog, importGuideCalls } = createMockEpgCatalog({
      programmesByChannel: (key, fromMs, toMs) => {
        const all =
          key === ch0.key
            ? [
                makeProgramme(key, 0, 60, 'Ch1 Six PM'),
                makeProgramme(key, 60, 120, 'Ch1 Seven PM'),
                makeProgramme(key, 120, 180, 'Ch1 Eight PM'),
                makeProgramme(key, 180, 240, 'Ch1 Nine PM'),
              ]
            : [
                makeProgramme(key, 0, 30, 'Ch2 Early Brief'),
                makeProgramme(key, 30, 75, 'Ch2 Mid Update'),
                makeProgramme(key, 75, 150, 'Ch2 Prime Feature'),
                makeProgramme(key, 150, 240, 'Ch2 Late Night'),
              ];
        return all.filter((p) => p.stop > fromMs && p.start < toMs);
      },
    });

    const onWatchChannel = jest.fn();
    const onEdgeTop = jest.fn();
    const { source: androidSource, sendKey } = createAndroidSource();

    const view = await renderEpg(
      {
        catalog,
        category: makeLiveCategory(channels.length),
        channelSource,
        sourceVersion: 0,
        refreshToken: 1,
        onWatchChannel,
        onEdgeTop,
        isActiveScope: true,
      },
      { androidSource, viewport: TV_VIEWPORT },
    );

    await waitFor(() => {
      expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-1-2')).toBeTruthy();
    });

    // Move Right on Ch 0 from slot 0 (18:00-19:00) -> slot 1 (19:00-20:00, midpoint 19:30)
    await sendKey(KEYCODE_DPAD_RIGHT);
    await waitFor(() => {
      expect(screen.getByText('Synopsis for Ch1 Seven PM')).toBeTruthy();
    });

    // Move Down to Ch 1 -> must snap to slot 2 (19:15-20:30, spanning 19:30), NOT slot 0!
    await sendKey(KEYCODE_DPAD_DOWN);
    await waitFor(() => {
      expect(screen.getByText('Synopsis for Ch2 Prime Feature')).toBeTruthy();
    });
    const focusedCell = screen.getByTestId('epg-cell-1-2');
    expect(focusedCell.props.accessibilityState?.selected).toBe(true);
    const defaultTheme = buildTheme({ preset: 'obsidianCrimson' });
    const focusedStyle = StyleSheet.flatten(focusedCell.props.style);
    expect(focusedStyle.borderColor).toBe(defaultTheme.colors.focusRingColor);
    expect(focusedStyle.borderWidth).toBe(2.5);

    // Pressing Select immediately watches Ch 1 at index 1
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(onWatchChannel).toHaveBeenCalledWith(ch1, 1);

    // Moving Up back to row 0, then Up enters EPG toolbar (Watch now -> Right -> Refresh guide -> Select)
    await sendKey(KEYCODE_DPAD_UP);
    await sendKey(KEYCODE_DPAD_UP);
    expect(onEdgeTop).not.toHaveBeenCalled();
    expect(screen.getByTestId('epg-watch-now-focus-ring')).toBeTruthy();

    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('epg-refresh-guide-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(importGuideCalls).toEqual(['src-1']);
    });

    // Up from EPG toolbar calls onEdgeTop; Down returns to row 0
    await sendKey(KEYCODE_DPAD_UP);
    expect(onEdgeTop).toHaveBeenCalledTimes(1);
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(screen.queryByTestId('epg-refresh-guide-focus-ring')).toBeNull();

    // Stepping Right past the visible 3h window edge automatically pans Later
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await waitFor(() => {
      expect(screen.getByTestId('epg-tick-0').props.children).toBe(
        formatClockTime(BASE_MS + EPG_PAN_STEP_MS),
      );
    });

    // Stepping Left moves to the first slot in the panned window, then pans back Earlier
    await sendKey(KEYCODE_DPAD_LEFT);
    await waitFor(() => {
      expect(screen.getByText('Synopsis for Ch1 Eight PM')).toBeTruthy();
    });
    await sendKey(KEYCODE_DPAD_LEFT);
    await waitFor(() => {
      expect(screen.getByTestId('epg-tick-0').props.children).toBe(formatClockTime(BASE_MS));
    });

    channelSource.dispose();
    await view.unmount();
  });

  it('supports Pan Earlier / Later, Jump to live, second-click tune, and Refresh guide via catalog.importGuide', async () => {
    const channels = [makeLiveChannel(0), makeLiveChannel(1)];
    const ch1 = channels[1] as ItemRow;
    const channelSource = makeLiveSource(channels);

    let guideRevision = 1;
    const { catalog, importGuideCalls } = createMockEpgCatalog({
      programmesByChannel: (key, fromMs, toMs) => {
        const list = [
          makeProgramme(key, -120, 0, `Earlier R${guideRevision}`),
          makeProgramme(key, 0, 60, `Live R${guideRevision}`),
          makeProgramme(key, 120, 240, `Later R${guideRevision}`),
        ];
        return list.filter((p) => p.stop > fromMs && p.start < toMs);
      },
      onImportGuide: async () => {
        guideRevision = 2;
      },
    });

    const onWatchChannel = jest.fn();
    const onGuideRefreshed = jest.fn();

    const view = await renderEpg({
      catalog,
      category: makeLiveCategory(channels.length),
      channelSource,
      sourceVersion: 0,
      refreshToken: 1,
      onWatchChannel,
      onGuideRefreshed,
    });

    await waitFor(() => {
      expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-1-0')).toBeTruthy();
    });

    // Clicking unfocused cell selects it first; clicking again watches it
    await fireEvent.press(screen.getByTestId('epg-cell-1-0'));
    expect(onWatchChannel).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('epg-cell-1-0'));
    expect(onWatchChannel).toHaveBeenCalledWith(ch1, 1);

    // Pan Later shifts ruler by +2h, hides Now line, and highlights Jump to live
    await fireEvent.press(screen.getByTestId('epg-pan-later'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-tick-0').props.children).toBe(
        formatClockTime(BASE_MS + EPG_PAN_STEP_MS),
      );
    });
    expect(screen.queryByTestId('epg-now-line')).toBeNull();
    expect(screen.getByTestId('epg-jump-now').props.accessibilityState?.selected).toBe(true);

    // Pan Earlier shifts ruler back by -2h
    await fireEvent.press(screen.getByTestId('epg-pan-earlier'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-tick-0').props.children).toBe(formatClockTime(BASE_MS));
    });
    expect(screen.getByTestId('epg-now-line')).toBeTruthy();

    // Pan Later again then Jump to live returns to live slot
    await fireEvent.press(screen.getByTestId('epg-pan-later'));
    await fireEvent.press(screen.getByTestId('epg-jump-now'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-tick-0').props.children).toBe(formatClockTime(BASE_MS));
      expect(screen.getByTestId('epg-now-line')).toBeTruthy();
    });

    // Refresh guide invokes catalog.importGuide, clears cache, and reloads revised guide data
    await fireEvent.press(screen.getByTestId('epg-refresh-guide'));
    await waitFor(() => {
      expect(importGuideCalls).toEqual(['src-1']);
      expect(onGuideRefreshed).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText('Live R2').length).toBeGreaterThanOrEqual(1);
    });

    // Watch now CTA triggers onWatchChannel
    await fireEvent.press(screen.getByTestId('epg-watch-now'));
    expect(onWatchChannel).toHaveBeenCalledTimes(2);

    channelSource.dispose();
    await view.unmount();
  });

  it('enforces >= 40x40 touch targets on Portrait touch and applies High Contrast AAA theme tokens cleanly', async () => {
    const ch0 = makeLiveChannel(0);
    const channelSource = makeLiveSource([ch0]);

    const { catalog } = createMockEpgCatalog({
      programmesByChannel: () => [],
    });

    const view = await renderEpg(
      {
        catalog,
        category: makeLiveCategory(1),
        channelSource,
        sourceVersion: 0,
        refreshToken: 1,
        onWatchChannel: jest.fn(),
      },
      {
        preset: 'highContrast',
        viewport: {
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('epg-watch-now')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy();
    });

    // Empty schedule renders localized fallback copy
    expect(
      screen.getAllByText('No guide schedule loaded for this window.').length,
    ).toBeGreaterThanOrEqual(1);

    // Touch controls meet >= 40x40 minimum target size
    for (const id of [
      'epg-watch-now',
      'epg-refresh-guide',
      'epg-pan-earlier',
      'epg-jump-now',
      'epg-pan-later',
    ]) {
      const style = StyleSheet.flatten(screen.getByTestId(id).props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(40);
      expect(style.minWidth).toBeGreaterThanOrEqual(40);
    }

    // High Contrast AAA tokens applied on focused cell & Now line
    const aaaTheme = buildTheme({ preset: 'highContrast' });
    const focusedCellStyle = StyleSheet.flatten(screen.getByTestId('epg-cell-0-0').props.style);
    expect(focusedCellStyle.borderColor).toBe(aaaTheme.colors.focusRingColor);
    const nowLineStyle = StyleSheet.flatten(screen.getByTestId('epg-now-line').props.style);
    expect(nowLineStyle.backgroundColor).toBe(aaaTheme.colors.accent);

    channelSource.dispose();
    await view.unmount();
  });

  it('ignores stale epgWindow responses after panning and virtualizes 1,000 channels on desktop VirtualizedList', async () => {
    const TOTAL_CHANNELS = 1_000;
    const { channelSource } = makeDynamicSource(TOTAL_CHANNELS);

    const deferreds: Array<{
      fromMs: number;
      resolve: (rows: Record<string, ProgrammeRow[]>) => void;
    }> = [];
    const catalog = {
      epgWindow: jest.fn(
        (channelKeys: readonly string[], fromMs: number) =>
          new Promise<Record<string, ProgrammeRow[]>>((resolve) => {
            deferreds.push({
              fromMs,
              resolve: (rows) => resolve(rows),
            });
            // Keep channelKeys referenced for deterministic test data
            void channelKeys;
          }),
      ),
    } as unknown as CatalogService;

    const view = await renderEpg({
      catalog,
      category: makeLiveCategory(TOTAL_CHANNELS),
      channelSource,
      sourceVersion: 0,
      refreshToken: 1,
      onWatchChannel: jest.fn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('epg-list')).toBeTruthy();
      expect(deferreds.length).toBe(1);
    });

    // Desktop VirtualizedList mounts <= 14 rows for 1,000 channels
    const mountedRows = screen.getAllByTestId(/^epg-row-\d+$/);
    expect(mountedRows.length).toBeLessThanOrEqual(14);

    // Pan Later while first request is still pending
    await fireEvent.press(screen.getByTestId('epg-pan-later'));
    await waitFor(() => {
      expect(deferreds.length).toBe(2);
    });

    const ch0Key = makeLiveChannel(0).key;
    // Resolve second (current) window first
    await act(async () => {
      deferreds[1]?.resolve({
        [ch0Key]: [makeProgramme(ch0Key, 120, 180, 'Fresh Window Show')],
      });
    });
    await waitFor(() => {
      expect(screen.getAllByText('Fresh Window Show').length).toBeGreaterThanOrEqual(1);
    });

    // Now resolve first (stale) window — monotonic generation guard must discard it!
    await act(async () => {
      deferreds[0]?.resolve({
        [ch0Key]: [makeProgramme(ch0Key, 0, 60, 'Stale Window Show')],
      });
    });
    expect(screen.queryByText('Stale Window Show')).toBeNull();
    expect(screen.getAllByText('Fresh Window Show').length).toBeGreaterThanOrEqual(1);

    channelSource.dispose();
    await view.unmount();
  });

  it('keeps cached programmes visible after 90s TTL expiry and refreshes seamlessly on clock ticks (stale-while-revalidate)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW_MS);

    try {
      const ch0 = makeLiveChannel(0);
      const channelSource = createPagedListSource<ItemRow>({
        count: 1,
        pageSize: LIVE_PAGE_SIZE,
        maxPages: LIVE_MAX_PAGES,
        loadPage: async () => [ch0],
      });

      let resolveRefresh: ((rows: Record<string, ProgrammeRow[]>) => void) | null = null;
      let callCount = 0;
      const catalog = {
        epgWindow: jest.fn((channelKeys: readonly string[]) => {
          callCount += 1;
          const key = channelKeys[0] ?? ch0.key;
          if (callCount === 1) {
            return Promise.resolve({
              [key]: [makeProgramme(key, 0, 60, 'Initial Evening Show', 'Live coverage.')],
            });
          }
          return new Promise<Record<string, ProgrammeRow[]>>((resolve) => {
            resolveRefresh = resolve;
          });
        }),
      } as unknown as CatalogService;

      const view = await renderEpg({
        catalog,
        category: makeLiveCategory(1),
        channelSource,
        sourceVersion: 0,
        refreshToken: 1,
        nowMs: 'live',
        onWatchChannel: jest.fn(),
      });

      await waitFor(() => {
        expect(screen.getAllByText('Initial Evening Show').length).toBeGreaterThanOrEqual(1);
      });
      expect(callCount).toBe(1);

      // Advance 120s (4 × 30s clock ticks, past EPG_CACHE_TTL_MS = 90s)
      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });

      // While background refresh is still in-flight, cached programme MUST stay visible (no blank flash!)
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('Initial Evening Show').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('No guide schedule loaded for this window.')).toBeNull();

      // Completing background refresh swaps in fresh programmes seamlessly
      await act(async () => {
        resolveRefresh?.({
          [ch0.key]: [makeProgramme(ch0.key, 0, 60, 'Updated Evening Show', 'Fresh coverage.')],
        });
      });
      await waitFor(() => {
        expect(screen.getAllByText('Updated Evening Show').length).toBeGreaterThanOrEqual(1);
      });

      channelSource.dispose();
      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets VirtualizedList scroll offset to 0 when switching categories', async () => {
    const scrollSpy = jest
      .spyOn(VirtualizedList.prototype, 'scrollToOffset')
      .mockImplementation(() => {});

    const ch0 = makeLiveChannel(0);
    const channelSource = makeLiveSource([ch0]);
    const { catalog } = createMockEpgCatalog({
      programmesByChannel: (key) => [makeProgramme(key, 0, 60, 'News')],
    });

    const catA = makeLiveCategory(1);
    const catB: DisplayCategory = {
      row: { ...catA.row, id: 'src-1|live|sports', name: 'Sports' },
      label: 'Sports',
    };
    const shared = {
      catalog,
      channelSource,
      sourceVersion: 0,
      refreshToken: 1,
      onWatchChannel: jest.fn(),
    };

    const view = await render(buildEpgTree({ ...shared, category: catA }));
    await waitFor(() => {
      expect(screen.getByTestId('epg-list')).toBeTruthy();
    });

    scrollSpy.mockClear();
    await view.rerender(buildEpgTree({ ...shared, category: catB }));
    expect(scrollSpy).toHaveBeenCalledWith({ offset: 0, animated: false });

    channelSource.dispose();
    await view.unmount();
  });
});

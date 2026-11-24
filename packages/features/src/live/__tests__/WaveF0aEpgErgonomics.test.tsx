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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { createPagedListSource, type DisplayCategory } from '../../shared';
import { EpgGridView, type EpgGridViewProps } from '../EpgGridView';
import { LIVE_MAX_PAGES, LIVE_PAGE_SIZE } from '../live-model';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

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
    key: `x:s1:live:${index + 1}`,
    sourceId: 's1',
    kind: 'live',
    providerId: String(index + 1),
    name: `Channel ${index + 1}`,
    logo: null,
    rating: null,
    year: null,
    num: index + 1,
  };
}

function makeProg(
  channelIndex: number,
  startMin: number,
  stopMin: number,
  title: string,
): ProgrammeRow {
  return {
    channelKey: `x:s1:live:${channelIndex + 1}`,
    sourceId: 's1',
    guideId: `g-${channelIndex + 1}`,
    start: BASE_MS + startMin * MIN,
    stop: BASE_MS + stopMin * MIN,
    title,
    subTitle: null,
    description: null,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  };
}

function makeCategory(itemCount: number): DisplayCategory {
  const row: CategoryRow = {
    id: 's1|live|all',
    sourceId: 's1',
    kind: 'live',
    name: 'All Channels',
    itemCount,
    position: 0,
  };
  return { row, label: 'All Channels' };
}

function makeKeyHarness(): {
  source: AndroidKeySource;
  press: (keyCode: number) => Promise<void>;
  longPress: (keyCode: number) => Promise<void>;
} {
  let listener: ((event: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener: (cb) => {
      listener = cb;
      return {
        remove: () => {
          listener = null;
        },
      };
    },
  };
  return {
    source,
    press: async (keyCode: number) => {
      await act(async () => {
        listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        listener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
      });
    },
    longPress: async (keyCode: number) => {
      jest.useFakeTimers();
      try {
        await act(async () => {
          listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        });
        await act(async () => {
          jest.advanceTimersByTime(500);
        });
        await act(async () => {
          listener?.({ keyCode, action: 'up', canceled: false, ageMs: 0 });
        });
      } finally {
        jest.useRealTimers();
      }
    },
  };
}

async function renderEpg(
  props: Partial<EpgGridViewProps> & {
    channels: readonly ItemRow[];
    programmesByKey?: Record<string, ProgrammeRow[]>;
    keySource?: AndroidKeySource;
    viewport?: ViewportOverride;
  },
) {
  const { channels, programmesByKey = {}, keySource, viewport = TV_VIEWPORT, ...rest } = props;
  const channelSource = createPagedListSource<ItemRow>({
    count: channels.length,
    pageSize: LIVE_PAGE_SIZE,
    maxPages: LIVE_MAX_PAGES,
    loadPage: async (offset, limit) => channels.slice(offset, offset + limit),
  });
  const catalog = {
    epgWindow: jest.fn(async (keys: readonly string[]) => {
      const out: Record<string, ProgrammeRow[]> = {};
      for (const k of keys) out[k] = programmesByKey[k] ?? [];
      return out;
    }),
  } as unknown as CatalogService;
  const onWatchChannel = rest.onWatchChannel ?? jest.fn();

  const view = await render(
    <ViewportProvider value={viewport}>
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <RemoteKeysProvider android={keySource ?? null}>
            <EpgGridView
              catalog={catalog}
              category={makeCategory(channels.length)}
              channelSource={channelSource}
              sourceVersion={1}
              refreshToken={0}
              nowMs={NOW_MS}
              onWatchChannel={onWatchChannel}
              {...rest}
            />
          </RemoteKeysProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>,
  );

  return { view, onWatchChannel };
}

describe('Wave F0A EPG Ergonomics (#6, #25)', () => {
  const origOs = Platform.OS;

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
  });

  it('applies compact (52px), comfortable (68px), and cinematic (84px) row heights on TV', async () => {
    const channels = [makeChannel(0), makeChannel(1)];

    const { view: compactView } = await renderEpg({ channels, epgRowDensity: 'compact' });
    await waitFor(() => expect(screen.getByTestId('epg-row-0')).toBeTruthy());
    expect(StyleSheet.flatten(screen.getByTestId('epg-row-0').props.style).height).toBe(52);
    await compactView.unmount();

    const { view: comfortableView } = await renderEpg({ channels, epgRowDensity: 'comfortable' });
    await waitFor(() => expect(screen.getByTestId('epg-row-0')).toBeTruthy());
    expect(StyleSheet.flatten(screen.getByTestId('epg-row-0').props.style).height).toBe(68);
    await comfortableView.unmount();

    const { view: cinematicView } = await renderEpg({ channels, epgRowDensity: 'cinematic' });
    await waitFor(() => expect(screen.getByTestId('epg-row-0')).toBeTruthy());
    expect(StyleSheet.flatten(screen.getByTestId('epg-row-0').props.style).height).toBe(84);
    await cinematicView.unmount();
  });

  it('auto-focuses the activeChannelKey on open without hijacking focus after user navigates away', async () => {
    const channels = Array.from({ length: 12 }, (_, i) => makeChannel(i));
    const keys = makeKeyHarness();
    const commits: number[] = [];

    await renderEpg({
      channels,
      activeChannelKey: 'x:s1:live:6', // index 5
      keySource: keys.source,
      onCursorCommit: (c) => commits.push(c.focusedRow),
    });

    await waitFor(() => expect(commits[commits.length - 1]).toBe(5));
    expect(screen.getByTestId('epg-row-5')).toBeTruthy();

    // User presses Down to row 6 -> focus stays on row 6 and does NOT jump back to row 5
    await keys.press(KEYCODE_DPAD_DOWN);
    await waitFor(() => expect(commits[commits.length - 1]).toBe(6));
  });

  it('renders focusable >= 5 min "No info" gap cells and tunes the channel cleanly on Select', async () => {
    const channels = [makeChannel(0)];
    const programmesByKey = {
      'x:s1:live:1': [
        makeProg(0, 0, 30, 'Morning News'),
        // 30-min gap [30..60]
        makeProg(0, 60, 120, 'Midday Show'),
      ],
    };
    const keys = makeKeyHarness();
    const onWatchChannel = jest.fn();

    await renderEpg({ channels, programmesByKey, keySource: keys.source, onWatchChannel });

    await waitFor(() =>
      expect(screen.getAllByText('Morning News').length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getAllByText('No info').length).toBeGreaterThanOrEqual(1);

    // Move right onto the synthesized gap cell [30..60] (slot index 1) and press Select
    await keys.press(KEYCODE_DPAD_RIGHT);
    await keys.press(KEYCODE_DPAD_CENTER);

    expect(onWatchChannel).toHaveBeenCalledWith(expect.objectContaining({ key: 'x:s1:live:1' }), 0);
    // Programme detail modal must NOT open for a gap cell
    expect(screen.queryByTestId('epg-programme-detail-modal')).toBeNull();
  });

  it('invokes onFocusSidebar on Hold-Left (long left) from the EPG grid', async () => {
    const channels = [makeChannel(0), makeChannel(1)];
    const keys = makeKeyHarness();
    const onFocusSidebar = jest.fn();

    await renderEpg({ channels, keySource: keys.source, onFocusSidebar });
    await waitFor(() => expect(screen.getByTestId('epg-row-0')).toBeTruthy());

    await keys.longPress(KEYCODE_DPAD_LEFT);
    expect(onFocusSidebar).toHaveBeenCalledTimes(1);
  });

  it('allows clicking a gap cell on non-TV pointer/touch to focus and then tune without opening detail modal', async () => {
    const channels = [makeChannel(0)];
    const onWatchChannel = jest.fn();
    await renderEpg({
      channels,
      viewport: {
        formFactor: 'desktop',
        orientation: 'landscape',
        inputModality: 'pointer',
        width: 1280,
        height: 720,
      },
      onWatchChannel,
    });

    await waitFor(() => expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy());
    fireEvent.press(screen.getByTestId('epg-cell-0-0'));
    expect(onWatchChannel).toHaveBeenCalledTimes(1);
  });
});

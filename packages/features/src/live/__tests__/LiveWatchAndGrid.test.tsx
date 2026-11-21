import type { SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  I18nProvider,
  resolveViewport,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, VirtualizedList } from 'react-native';
import { computeLiveGridColumns } from '../LiveChannelsGrid';
import { NUMBER_JUMP_TIMEOUT_MS } from '../live-model';
import {
  createAndroidSource,
  createLiveMockCatalog,
  LiveHubHarness,
  makeLiveCategory,
  makeSource,
  renderHarness,
} from './live-watch-test-fixtures';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

describe('LiveChannelsGrid & LiveWatchStage', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('computes responsive Live Channels grid columns across form factors', () => {
    expect(
      computeLiveGridColumns(
        resolveViewport({
          isTV: true,
          os: 'android',
          width: 1920,
          height: 1080,
        }),
      ),
    ).toBe(3);
    expect(
      computeLiveGridColumns(
        resolveViewport({
          isTV: false,
          os: 'web',
          width: 1280,
          height: 800,
        }),
      ),
    ).toBe(3);
    expect(
      computeLiveGridColumns(
        resolveViewport({
          isTV: false,
          os: 'ios',
          width: 768,
          height: 1024,
        }),
      ),
    ).toBe(2);
    expect(
      computeLiveGridColumns(
        resolveViewport({
          isTV: false,
          os: 'ios',
          width: 390,
          height: 844,
        }),
      ),
    ).toBe(1);
  });

  it('renders O(1) virtualized grid over 2,000 channels with bounded page & Now/Next hydration and launches playback on click', async () => {
    const cat = makeLiveCategory(0, { itemCount: 2_000 });
    const { catalog, itemsCalls, nowNextCalls } = createLiveMockCatalog({
      categories: [cat],
      totalChannels: 2_000,
    });
    const onWatchChannel = jest.fn();

    const view = await renderHarness({
      catalog,
      sources: [makeSource()],
      initialMode: 'channels',
      onWatchChannel,
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
      expect(screen.getByText('Evening News 101')).toBeTruthy();
    });

    // Bounded initial page fetch (<= 120, never 2,000)
    expect(itemsCalls.length).toBeGreaterThanOrEqual(1);
    expect(itemsCalls.length).toBeLessThanOrEqual(2);
    for (const call of itemsCalls) {
      expect(call.limit).toBeLessThanOrEqual(120);
    }

    // Bounded Now/Next batch fetch (<= 60 keys per call)
    expect(nowNextCalls.length).toBeGreaterThanOrEqual(1);
    const totalRequestedKeys = nowNextCalls.reduce((sum, batch) => sum + batch.length, 0);
    expect(totalRequestedKeys).toBeLessThanOrEqual(60);
    for (const batch of nowNextCalls) {
      expect(batch.length).toBeLessThanOrEqual(60);
    }

    // Displays Up next subtitle and 50% live progress bar
    expect(screen.getByText(/Up next: Late Report 101/)).toBeTruthy();
    const progressStyle = StyleSheet.flatten(
      screen.getByTestId('live-channel-progress-0').props.style,
    );
    expect(progressStyle.width).toBe('50%');

    // Clicking channel card launches playback
    await fireEvent.press(screen.getByTestId('live-channel-card-0'));
    expect(onWatchChannel).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'live:src-1:ch-0', num: 101 }),
      0,
    );

    await view.unmount();
  });

  it('supports 10-ft TV 2D D-pad navigation with focusable={false} and bounded mounted rows over 2,000 channels', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const cat = makeLiveCategory(0, { itemCount: 2_000 });
    const { catalog } = createLiveMockCatalog({
      categories: [cat],
      totalChannels: 2_000,
    });
    const android = createAndroidSource();
    const onWatchChannel = jest.fn();
    const onEdgeTop = jest.fn();

    const view = await renderHarness(
      {
        catalog,
        sources: [makeSource()],
        initialMode: 'channels',
        onWatchChannel,
        onEdgeTop,
      },
      {
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        },
        androidSource: android.source,
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channels-tv-viewport')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // TV cards use JS-owned focus (focusable={false})
    expect(screen.getByTestId('live-channel-card-0').props.focusable).toBe(false);

    // Strictly bounded O(1) mounted rows (<< 2,000)
    const mountedRows = screen.getAllByTestId(/^live-channel-row-\d+$/);
    expect(mountedRows.length).toBeLessThanOrEqual(12);

    // Up from row 0 notifies onEdgeTop
    await android.sendKey(KEYCODE_DPAD_UP);
    expect(onEdgeTop).toHaveBeenCalledTimes(1);

    // Move Right (0 -> 1 -> 2), Left (2 -> 1), Down (row 0 -> 1, col 1 => index 4 on 3-col TV grid), then Select
    await android.sendKey(KEYCODE_DPAD_RIGHT);
    await android.sendKey(KEYCODE_DPAD_RIGHT);
    await android.sendKey(KEYCODE_DPAD_LEFT);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_CENTER);

    expect(onWatchChannel).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'live:src-1:ch-4', num: 105 }),
      4,
    );

    await view.unmount();
  });

  it('toggles Mini-Guide Zap Drawer in Favorites stage, omits prev/numpad clutter, and jumps via 0-9 Number Pad in Channels mode', async () => {
    const cat0 = makeLiveCategory(0, { itemCount: 10 });
    const cat1 = makeLiveCategory(1, { itemCount: 5 });
    const { catalog, channelByNumberCalls } = createLiveMockCatalog({
      categories: [cat0, cat1],
      totalChannels: 10,
    });
    const onWatchChannel = jest.fn();

    const view = await renderHarness({
      catalog,
      sources: [makeSource()],
      initialMode: 'favorites',
      onWatchChannel,
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-zap-drawer')).toBeTruthy();
      expect(screen.getByTestId('live-stage-channel-title')).toBeTruthy();
    });

    // Initial active channel is #101; zero prev-channel or numpad clutter in Favorites stage
    expect(screen.getByTestId('live-stage-channel-title').props.children).toContain('101');
    expect(screen.queryByTestId('live-prev-channel')).toBeNull();
    expect(screen.queryByTestId('live-toggle-numpad')).toBeNull();

    // Toggle Mini-Guide off and back on
    await fireEvent.press(screen.getByTestId('live-toggle-miniguide'));
    expect(screen.queryByTestId('live-zap-drawer')).toBeNull();
    await fireEvent.press(screen.getByTestId('live-toggle-miniguide'));
    expect(screen.getByTestId('live-zap-drawer')).toBeTruthy();

    // Watch live CTA launches fullscreen playback for active channel #101
    await fireEvent.press(screen.getByTestId('live-watch-fullscreen'));
    expect(onWatchChannel).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'live:src-1:ch-0', num: 101 }),
      0,
    );

    // Switch to Channels mode -> open Number Pad, enter 1-0-2 and submit ↵
    await fireEvent.press(screen.getByTestId('live-mode-channels'));
    await fireEvent.press(screen.getByTestId('live-channels-numpad-toggle'));
    expect(screen.getByTestId('live-numpad')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('live-numpad-key-1'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-0'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-2'));
    expect(screen.getByTestId('live-numpad-display').props.children).toBe('102');

    await fireEvent.press(screen.getByTestId('live-numpad-key-↵'));
    await waitFor(() => {
      expect(channelByNumberCalls).toContainEqual({ num: 102, sourceId: 'src-1' });
      expect(screen.getByTestId('live-channel-card-1').props.accessibilityState.selected).toBe(
        true,
      );
    });

    // Not-found channel number shows feedback
    await fireEvent.press(screen.getByTestId('live-numpad-key-9'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-9'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-9'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-↵'));

    await waitFor(() => {
      expect(screen.getByTestId('live-numpad-feedback').props.children).toBe('No channel #999');
    });

    await view.unmount();
  });

  it('auto-tunes after NUMBER_JUMP_TIMEOUT_MS and cleans up timer on unmount', async () => {
    jest.useFakeTimers();
    const cat0 = makeLiveCategory(0, { itemCount: 10 });
    const { catalog, channelByNumberCalls } = createLiveMockCatalog({
      categories: [cat0],
      totalChannels: 10,
    });

    const view = await renderHarness({
      catalog,
      sources: [makeSource()],
      initialMode: 'channels',
      onWatchChannel: jest.fn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-channels-numpad-toggle')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('live-channels-numpad-toggle'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-1'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-0'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-3'));

    expect(channelByNumberCalls).toHaveLength(0);

    await act(async () => {
      jest.advanceTimersByTime(NUMBER_JUMP_TIMEOUT_MS);
    });

    await waitFor(() => {
      expect(channelByNumberCalls).toContainEqual({ num: 103, sourceId: 'src-1' });
      expect(screen.getByTestId('live-channel-card-2').props.accessibilityState.selected).toBe(
        true,
      );
    });

    // Enter another digit and unmount before timer fires — must NOT call channelByNumber again
    const countBeforeUnmount = channelByNumberCalls.length;
    await fireEvent.press(screen.getByTestId('live-numpad-key-1'));
    await view.unmount();

    await act(async () => {
      jest.advanceTimersByTime(NUMBER_JUMP_TIMEOUT_MS * 2);
    });
    expect(channelByNumberCalls).toHaveLength(countBeforeUnmount);
  });

  it('enforces >= 40x40 touch targets on Portrait touch and renders cleanly under High Contrast (AAA)', async () => {
    const cat = makeLiveCategory(0, { itemCount: 5 });
    const { catalog } = createLiveMockCatalog({
      categories: [cat],
      totalChannels: 5,
    });

    const view = await renderHarness(
      {
        catalog,
        sources: [makeSource()],
        initialMode: 'favorites',
        onWatchChannel: jest.fn(),
      },
      {
        viewport: {
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        },
        preset: 'highContrast',
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-mode-favorites')).toBeTruthy();
    });

    // High Contrast AAA canvas (#000000)
    const stageStyle = StyleSheet.flatten(screen.getByTestId('live-watch-stage').props.style);
    expect(stageStyle.backgroundColor).toBe('#000000');

    // Mode switcher touch targets >= 40x40
    const modeFavStyle = StyleSheet.flatten(screen.getByTestId('live-mode-favorites').props.style);
    expect(modeFavStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(modeFavStyle.minWidth).toBeGreaterThanOrEqual(40);

    // Top overlay action buttons >= 40x40
    const miniGuideStyle = StyleSheet.flatten(
      screen.getByTestId('live-toggle-miniguide').props.style,
    );
    expect(miniGuideStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(miniGuideStyle.minWidth).toBeGreaterThanOrEqual(40);

    // Switch to Channels mode via LiveModeSwitcher and verify single-column grid + numpad >= 40x40
    await fireEvent.press(screen.getByTestId('live-mode-channels'));
    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('live-channels-numpad-toggle'));
    const keyStyle = StyleSheet.flatten(screen.getByTestId('live-numpad-key-5').props.style);
    expect(keyStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(keyStyle.minWidth).toBeGreaterThanOrEqual(40);

    await view.unmount();
  });

  it('uses an O(1) bounded TV viewport in LiveZapDrawer that follows focusedZapIndex past row 10 and prefetches page 1 at row 150', async () => {
    const cat = makeLiveCategory(0, { itemCount: 500 });
    const { catalog, itemsCalls, nowNextCalls } = createLiveMockCatalog({
      categories: [cat],
      totalChannels: 500,
    });
    const stableSources = [makeSource()];
    const stableI18n = createAppI18n('en');
    const tvViewport: ViewportOverride = {
      formFactor: 'tv',
      orientation: 'landscape',
      inputModality: 'tv',
      width: 1920,
      height: 1080,
    };
    const onWatch = jest.fn();

    const buildTree = (focusedZapIndex: number) => (
      <ViewportProvider value={tvViewport}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={stableI18n}>
            <LiveHubHarness
              catalog={catalog}
              sources={stableSources}
              initialMode="favorites"
              focusedZapIndex={focusedZapIndex}
              onWatchChannel={onWatch}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(buildTree(0));
    await waitFor(() => {
      expect(screen.getByTestId('live-zap-tv-viewport')).toBeTruthy();
      expect(screen.getByTestId('live-zap-row-0')).toBeTruthy();
    });
    expect(screen.getAllByTestId(/^live-zap-row-\d+$/).length).toBeLessThanOrEqual(12);

    // Step focusedZapIndex to row 15 -> row 15 mounts in view and hydrates Now/Next
    await view.rerender(buildTree(15));
    await waitFor(() => {
      expect(screen.getByTestId('live-zap-row-15')).toBeTruthy();
      expect(nowNextCalls.some((batch) => batch.includes('live:src-1:ch-15'))).toBe(true);
    });
    expect(screen.getAllByTestId(/^live-zap-row-\d+$/).length).toBeLessThanOrEqual(12);

    // Step focusedZapIndex to row 150 -> prefetches page 1 (offset 120) and mounts row 150
    await view.rerender(buildTree(150));
    await waitFor(() => {
      expect(itemsCalls.some((c) => c.offset === 120)).toBe(true);
      expect(screen.getByTestId('live-zap-row-150')).toBeTruthy();
      expect(nowNextCalls.some((batch) => batch.includes('live:src-1:ch-150'))).toBe(true);
    });
    expect(screen.getAllByTestId(/^live-zap-row-\d+$/).length).toBeLessThanOrEqual(12);

    await view.unmount();
  });

  it('calls onEdgeTop when pressing Back from deep inside LiveChannelsGrid on 10-ft TV', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const cat = makeLiveCategory(0, { itemCount: 2_000 });
    const { catalog } = createLiveMockCatalog({ categories: [cat], totalChannels: 2_000 });
    const android = createAndroidSource();
    const onEdgeTop = jest.fn();

    const view = await renderHarness(
      {
        catalog,
        sources: [makeSource()],
        initialMode: 'channels',
        onWatchChannel: jest.fn(),
        onEdgeTop,
      },
      {
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        },
        androidSource: android.source,
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // Move deep into row 2 then press Back -> must escape immediately via onEdgeTop
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    expect(onEdgeTop).not.toHaveBeenCalled();

    await android.sendKey(KEYCODE_BACK);
    expect(onEdgeTop).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('hydrates active channel on mount and shows empty favorites fallback when sources become empty', async () => {
    const cat = makeLiveCategory(0, { itemCount: 500 });
    const { catalog } = createLiveMockCatalog({ categories: [cat], totalChannels: 500 });
    const stableI18n = createAppI18n('en');
    const desktopViewport: ViewportOverride = {
      formFactor: 'desktop',
      orientation: 'landscape',
      inputModality: 'pointer',
      width: 1280,
      height: 800,
    };
    const onWatch = jest.fn();

    const buildTree = (sources: readonly SourceRow[]) => (
      <ViewportProvider value={desktopViewport}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={stableI18n}>
            <LiveHubHarness
              catalog={catalog}
              sources={sources}
              initialMode="favorites"
              activeChannelKey="live:src-1:ch-1"
              previousChannelKey="live:src-1:ch-400"
              onWatchChannel={onWatch}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(buildTree([makeSource()]));

    await waitFor(() => {
      expect(screen.getByTestId('live-stage-channel-title').props.children).toContain('102');
      expect(catalog.itemDetail).toHaveBeenCalledWith('live:src-1:ch-400');
    });

    // Emptying sources resets active channel and shows empty favorites stage cleanly
    await view.rerender(buildTree([]));
    await waitFor(() => {
      expect(screen.getByTestId('live-favorites-empty')).toBeTruthy();
    });

    await view.unmount();
  });

  it('resets VirtualizedList scroll offset to 0 when switching categories in LiveChannelsGrid', async () => {
    const scrollSpy = jest
      .spyOn(VirtualizedList.prototype, 'scrollToOffset')
      .mockImplementation(() => {});
    const cat0 = makeLiveCategory(0, { itemCount: 50 });
    const cat1 = makeLiveCategory(1, { itemCount: 50 });
    const { catalog } = createLiveMockCatalog({ categories: [cat0, cat1], totalChannels: 50 });

    const view = await renderHarness({
      catalog,
      sources: [makeSource()],
      initialMode: 'channels',
      onWatchChannel: jest.fn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-cat-chip-1')).toBeTruthy();
      expect(screen.getByTestId('live-channels-list')).toBeTruthy();
    });

    scrollSpy.mockClear();
    await fireEvent.press(screen.getByTestId('live-cat-chip-1'));

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ offset: 0, animated: false });
    });

    await view.unmount();
  });
});

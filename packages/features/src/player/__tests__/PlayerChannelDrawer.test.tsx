import type { NowNextEntry } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { LiveChannelPlaylist, PlayableEntry } from '../../ports/play-target';
import { computeChannelWindow, PlayerChannelDrawer } from '../PlayerChannelDrawer';

function makeChannel(index: number): PlayableEntry {
  return {
    itemKey: `m:src:ch:${index}`,
    sourceId: 'src',
    title: `Channel ${index + 1}`,
    kind: 'live',
    itemKind: 'live',
  };
}

function makePlaylist(count: number, currentIndex: number) {
  const getAt = jest.fn(async (idx: number) =>
    idx >= 0 && idx < count ? makeChannel(idx) : undefined,
  );
  const playlist: LiveChannelPlaylist = {
    count,
    currentIndex,
    getAt,
    onChangeIndex: jest.fn(),
  };
  return { playlist, getAt };
}

function makeNowNext(channelKey: string, nowTitle: string, nextTitle: string): NowNextEntry {
  const base = new Date(2026, 10, 22, 20, 0, 0, 0).getTime();
  return {
    channelKey,
    now: {
      channelKey,
      sourceId: 'src',
      guideId: channelKey,
      start: base,
      stop: base + 3_600_000,
      title: nowTitle,
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
    },
    next: {
      channelKey,
      sourceId: 'src',
      guideId: channelKey,
      start: base + 3_600_000,
      stop: base + 7_200_000,
      title: nextTitle,
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
    },
  };
}

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('computeChannelWindow', () => {
  it('centers a bounded window around focus without exceeding total count', () => {
    expect(computeChannelWindow(0, 0, 25)).toEqual({ start: 0, end: -1 });
    expect(computeChannelWindow(10, 3, 25)).toEqual({ start: 0, end: 9 });
    expect(computeChannelWindow(10_000, 500, 25)).toEqual({ start: 488, end: 512 });
    expect(computeChannelWindow(10_000, 2, 25)).toEqual({ start: 0, end: 24 });
    expect(computeChannelWindow(10_000, 9_999, 25)).toEqual({ start: 9_975, end: 9_999 });
  });
});

describe('PlayerChannelDrawer', () => {
  it('returns null when hidden', async () => {
    const i18n = createAppI18n('en');
    const { playlist } = makePlaylist(10, 2);
    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <PlayerChannelDrawer
            visible={false}
            playlist={playlist}
            currentItemKey="m:src:ch:2"
            formFactor="desktop"
            isTv={false}
            i18n={i18n}
            onSelectChannel={jest.fn()}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('player-channel-drawer-panel')).toBeNull();
    await view.unmount();
  });

  it('starts focus on playing channel, bounds loading to <=25 rows, shows Now/Next schedule, and zaps on select', async () => {
    const i18n = createAppI18n('en');
    const { playlist, getAt } = makePlaylist(10_000, 500);
    const fetchNowNext = jest.fn(async (key: string) =>
      makeNowNext(key, `Live Show on ${key}`, `Next Show on ${key}`),
    );
    const onSelectChannel = jest.fn();
    const onClose = jest.fn();

    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <PlayerChannelDrawer
            visible
            playlist={playlist}
            currentItemKey="m:src:ch:500"
            formFactor="desktop"
            isTv={false}
            i18n={i18n}
            fetchNowNext={fetchNowNext}
            onSelectChannel={onSelectChannel}
            onClose={onClose}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    // Desktop docks in normal flex flow (HWND-safe, no position: absolute)
    expect(screen.getByTestId('player-channel-drawer-desktop')).toBeTruthy();
    expect(flatStyle('player-channel-drawer-desktop')?.position).toBeUndefined();

    await waitFor(() => {
      expect(screen.getByTestId('player-channel-row-500')).toBeTruthy();
      expect(screen.getByTestId('player-channel-drawer-schedule')).toHaveTextContent(
        /Live Show on m:src:ch:500/,
      );
    });

    // Bounded sliding window: never loads all 10,000 rows!
    expect(getAt.mock.calls.length).toBeLessThanOrEqual(25);
    expect(screen.getByTestId('player-channel-row-500').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByTestId('player-channel-drawer-schedule')).toHaveTextContent(
      /Next Show on m:src:ch:500/,
    );

    // Selecting another channel triggers onSelectChannel with entry + index
    await fireEvent.press(screen.getByTestId('player-channel-row-501'));
    expect(onSelectChannel).toHaveBeenCalledWith(makeChannel(501), 501);

    // Close button triggers onClose
    await fireEvent.press(screen.getByTestId('player-channel-drawer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('moves focus via keyboard ArrowDown and updates focused channel schedule, and closes on Escape', async () => {
    const i18n = createAppI18n('en');
    const { playlist } = makePlaylist(5, 1);
    const fetchNowNext = jest.fn(async (key: string) =>
      makeNowNext(key, `Now ${key}`, `UpNext ${key}`),
    );
    const onSelectChannel = jest.fn();
    const onClose = jest.fn();

    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <PlayerChannelDrawer
            visible
            playlist={playlist}
            currentItemKey="m:src:ch:1"
            formFactor="desktop"
            isTv={false}
            i18n={i18n}
            fetchNowNext={fetchNowNext}
            onSelectChannel={onSelectChannel}
            onClose={onClose}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('player-channel-drawer-schedule')).toHaveTextContent(
        /Now m:src:ch:1/,
      );
    });

    const panel = screen.getByTestId('player-channel-drawer-desktop');
    await act(async () => {
      panel.props.onKeyDown?.({ key: 'ArrowDown', preventDefault: jest.fn() });
    });

    await waitFor(() => {
      expect(screen.getByTestId('player-channel-drawer-schedule')).toHaveTextContent(
        /Now m:src:ch:2/,
      );
    });

    await act(async () => {
      panel.props.onKeyDown?.({ key: 'Enter', preventDefault: jest.fn() });
    });
    expect(onSelectChannel).toHaveBeenCalledWith(makeChannel(2), 2);

    await act(async () => {
      panel.props.onKeyDown?.({ key: 'Escape', preventDefault: jest.fn() });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('renders empty state when playlist is empty and wraps in AdaptiveSheet on portrait mobile', async () => {
    const i18n = createAppI18n('en');
    const { playlist } = makePlaylist(0, 0);
    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <ViewportProvider
            value={{ width: 393, height: 852, formFactor: 'phone', orientation: 'portrait' }}
          >
            <PlayerChannelDrawer
              visible
              playlist={playlist}
              currentItemKey=""
              formFactor="phone"
              isTv={false}
              i18n={i18n}
              onSelectChannel={jest.fn()}
              onClose={jest.fn()}
            />
          </ViewportProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-channel-drawer-sheet')).toBeTruthy();
    expect(screen.getByTestId('player-channel-drawer-empty')).toHaveTextContent(
      /No channels in this group/,
    );

    await view.unmount();
  });
});

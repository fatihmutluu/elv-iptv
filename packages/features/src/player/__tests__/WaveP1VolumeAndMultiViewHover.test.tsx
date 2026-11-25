import { createAppI18n } from '@elv/i18n';
import type { MultiViewTile } from '@elv/playback';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { MultiViewTileCard } from '../MultiViewTileCard';
import { PlayerOsdTopBar } from '../PlayerOsdTopBar';

describe('Wave P1 volume safe-hover bridge and MultiViewTileCard hover', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('eliminates the vertical dead gap on player-volume-popover-bridge and opens on mute hover', async () => {
    const i18n = createAppI18n('en');
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
        <ThemeProvider>
          <I18nProvider i18n={i18n}>
            <PlayerOsdTopBar
              title="Test Stream"
              statusLine=""
              statusKind="playing"
              failure={null}
              isVod={false}
              isPausedOrEnded={false}
              canZap={false}
              hasTracks={false}
              showRetry={false}
              isTv={false}
              isDesktop
              muted={false}
              volume={70}
              tvOsdFocused={false}
              tvOsdAction="playPause"
              tracksOpen={false}
              i18n={i18n}
              service={{} as never}
              clock={{ now: () => 0 }}
              onExit={jest.fn()}
              onTogglePlayPause={jest.fn()}
              onSeekBack={jest.fn()}
              onSeekForward={jest.fn()}
              onSeekRatio={jest.fn()}
              onOpenTracks={jest.fn()}
              onToggleMute={jest.fn()}
              onSetVolume={jest.fn()}
              onPrev={jest.fn()}
              onNext={jest.fn()}
              onRetry={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    expect(screen.queryByTestId('player-volume-popover')).toBeNull();
    await act(async () => {
      fireEvent(screen.getByTestId('player-mute-button'), 'hoverIn');
    });

    const bridge = screen.getByTestId('player-volume-popover-bridge');
    expect(screen.getByTestId('player-volume-popover')).toBeTruthy();
    const bridgeStyle = StyleSheet.flatten(bridge.props.style);
    expect(bridgeStyle).toMatchObject({ top: 38, paddingTop: 6 });

    await view.unmount();
  });

  it('keeps MultiViewTileCard actions visible on web when child Pressable triggers hoverOut', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const i18n = createAppI18n('en');
    const tile: MultiViewTile = {
      tileId: 'tile-1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 4,
      streamId: 'stream-1',
      itemKey: 'x:s1:live:101',
      title: 'News Live',
      muted: true,
      status: 'playing',
    };
    const view = await render(
      <ThemeProvider>
        <MultiViewTileCard
          tile={tile}
          index={0}
          openedEngine={undefined}
          isActiveAudio={false}
          isTv={false}
          tvFocused={false}
          i18n={i18n}
          onSelectAudio={jest.fn()}
          onRequestReplace={jest.fn()}
          onRemove={jest.fn()}
        />
      </ThemeProvider>,
    );

    const tilePress = screen.getByTestId('multiview-tile-0');
    expect(screen.queryByTestId('multiview-tile-remove-btn-0')).toBeNull();

    await act(async () => {
      fireEvent(tilePress, 'hoverIn');
    });
    expect(screen.getByTestId('multiview-tile-remove-btn-0')).toBeTruthy();

    // On web, inner Pressable must not bind onHoverOut so child Pressable hover-lock cannot collapse actions
    expect(tilePress.props.onHoverOut).toBeUndefined();
    expect(screen.getByTestId('multiview-tile-remove-btn-0')).toBeTruthy();

    await view.unmount();
  });
});

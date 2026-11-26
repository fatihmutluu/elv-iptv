import type { SourceRow } from '@elv/data';
import { type DownloadManagerPort, type DownloadRecord, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker } from '@elv/playback';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render } from '@testing-library/react-native';
import { type ReactElement, useRef } from 'react';
import { Text, View } from 'react-native';
import {
  buildPlayTargetFromPopoutDock,
  buildPopoutLaunchPayload,
  useShellOnlinePlaybackSync,
} from '../../app-shell-desktop';
import { buildShellNavigation } from '../../app-shell-state';
import type { PlayTarget } from '../../ports/play-target';
import { StreamHealthProvider } from '../../shared';
import { useConnectionLimitGuard } from '../useConnectionLimitGuard';

async function wrapUi(node: ReactElement) {
  const i18n = createAppI18n('en');
  return render(
    <ViewportProvider
      value={{
        width: 1280,
        height: 720,
        formFactor: 'desktop',
        inputModality: 'pointer',
      }}
    >
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <StreamHealthProvider>{node}</StreamHealthProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>,
  );
}

function GuardHarness({
  sources,
  tracker,
  onOpenTarget,
  onGuard,
}: {
  sources: readonly SourceRow[];
  tracker: ReturnType<typeof createConnectionTracker>;
  onOpenTarget: (target: PlayTarget) => void;
  onGuard: (guard: ReturnType<typeof useConnectionLimitGuard>) => void;
}) {
  const sourcesRef = useRef(sources);
  const guard = useConnectionLimitGuard({
    sourcesRef,
    enrichTarget: (t) => t,
    connectionTracker: tracker,
    onOpenTarget,
    onReplaceTarget: jest.fn(),
  });
  onGuard(guard);
  return <View />;
}

function SyncHarness({
  downloadManager,
  playTarget,
  liveEmbeddedPlaybackActive,
  multiViewSeed = null,
  multiViewHasOnlineStream,
}: {
  downloadManager: DownloadManagerPort;
  playTarget: PlayTarget | null;
  liveEmbeddedPlaybackActive: boolean;
  multiViewSeed?: PlayTarget | null;
  multiViewHasOnlineStream?: boolean | null;
}) {
  useShellOnlinePlaybackSync({
    downloadManager,
    playTarget,
    liveEmbeddedPlaybackActive,
    multiViewSeed,
    multiViewHasOnlineStream,
  });
  return <Text>sync</Text>;
}

function makeDownloadManager(notifyOnlinePlaybackActive: jest.Mock): DownloadManagerPort {
  return {
    supported: true,
    list: async () => [],
    get: async () => null,
    enqueue: async () => ok({} as DownloadRecord),
    pause: async () => ok(undefined),
    resume: async () => ok(undefined),
    cancel: async () => ok(undefined),
    remove: async () => ok(undefined),
    notifyOnlinePlaybackActive,
    subscribe: () => () => {},
  };
}

describe('Offline zero-connection bypass & online playback download sync', () => {
  it('exposes 5 primary destinations including Library right after Series', () => {
    const i18n = createAppI18n('en');
    const nav = buildShellNavigation({
      t: i18n.t,
      activeTab: 'library',
      hasActiveDetail: false,
      onOpenSearch: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    expect(nav.destinations.map((d) => d.id)).toEqual([
      'home',
      'live',
      'movie',
      'series',
      'library',
    ]);
    expect(nav.destinations[4]).toMatchObject({
      id: 'library',
      icon: 'library',
      testID: 'nav-tab-library',
    });
  });

  it('bypasses ConnectionTracker completely when playing an offline download', async () => {
    const tracker = createConnectionTracker();
    tracker.acquire('src-1', 'other:live-1');
    const onOpenTarget = jest.fn();
    const sources: readonly SourceRow[] = [
      {
        id: 'src-1',
        name: 'Provider',
        kind: 'xtream',
        needsImport: false,
        accountMeta: { maxConnections: 1 },
      } as SourceRow,
    ];

    const guardBox: { current: ReturnType<typeof useConnectionLimitGuard> | null } = {
      current: null,
    };
    await wrapUi(
      <GuardHarness
        sources={sources}
        tracker={tracker}
        onOpenTarget={onOpenTarget}
        onGuard={(g) => {
          guardBox.current = g;
        }}
      />,
    );

    const offlineTarget: PlayTarget = {
      itemKey: 'movie:src-1:55',
      sourceId: 'src-1',
      title: 'Offline Movie',
      kind: 'vod',
      itemKind: 'movie',
      isLocalOffline: true,
      localFileUri: 'file:///downloads/offline.mp4',
    };

    await act(async () => {
      guardBox.current?.requestPlay(offlineTarget);
    });

    expect(guardBox.current?.pending).toBeNull();
    expect(onOpenTarget).toHaveBeenCalledWith(offlineTarget);
    expect(tracker.activeCount('src-1')).toBe(1);
  });

  it('notifies downloadManager when online playback starts, stops, or switches to offline', async () => {
    const notifyOnlinePlaybackActive = jest.fn();
    const downloadManager = makeDownloadManager(notifyOnlinePlaybackActive);

    const onlineTarget: PlayTarget = {
      itemKey: 'live:s1:1',
      sourceId: 's1',
      title: 'News',
      kind: 'live',
    };
    const offlineTarget: PlayTarget = {
      itemKey: 'movie:s1:2',
      sourceId: 's1',
      title: 'Saved Movie',
      kind: 'vod',
      isLocalOffline: true,
      localFileUri: 'file:///downloads/saved.mp4',
    };

    const rendered = await render(
      <SyncHarness
        downloadManager={downloadManager}
        playTarget={null}
        liveEmbeddedPlaybackActive={false}
      />,
    );
    expect(notifyOnlinePlaybackActive).not.toHaveBeenCalled();

    await rendered.rerender(
      <SyncHarness
        downloadManager={downloadManager}
        playTarget={onlineTarget}
        liveEmbeddedPlaybackActive={false}
      />,
    );
    expect(notifyOnlinePlaybackActive).toHaveBeenLastCalledWith(true);

    await rendered.rerender(
      <SyncHarness
        downloadManager={downloadManager}
        playTarget={offlineTarget}
        liveEmbeddedPlaybackActive={false}
      />,
    );
    expect(notifyOnlinePlaybackActive).toHaveBeenLastCalledWith(false);
  });

  it('notifies downloadManager when offline-seeded Multi-View adds an online tile', async () => {
    const notifyOnlinePlaybackActive = jest.fn();
    const downloadManager = makeDownloadManager(notifyOnlinePlaybackActive);
    const offlineSeed: PlayTarget = {
      itemKey: 'movie:s1:offline',
      sourceId: 's1',
      title: 'Offline Seed',
      kind: 'vod',
      itemKind: 'movie',
      isLocalOffline: true,
      localFileUri: 'file:///downloads/seed.mp4',
    };

    const rendered = await render(
      <SyncHarness
        downloadManager={downloadManager}
        playTarget={null}
        liveEmbeddedPlaybackActive={false}
        multiViewSeed={offlineSeed}
        multiViewHasOnlineStream={false}
      />,
    );
    expect(notifyOnlinePlaybackActive).not.toHaveBeenCalled();

    // Tile 2 mounts a Live TV stream inside offline-seeded Multi-View
    await rendered.rerender(
      <SyncHarness
        downloadManager={downloadManager}
        playTarget={null}
        liveEmbeddedPlaybackActive={false}
        multiViewSeed={offlineSeed}
        multiViewHasOnlineStream
      />,
    );
    expect(notifyOnlinePlaybackActive).toHaveBeenLastCalledWith(true);

    // Online tile removed -> back to offline-only Multi-View
    await rendered.rerender(
      <SyncHarness
        downloadManager={downloadManager}
        playTarget={null}
        liveEmbeddedPlaybackActive={false}
        multiViewSeed={offlineSeed}
        multiViewHasOnlineStream={false}
      />,
    );
    expect(notifyOnlinePlaybackActive).toHaveBeenLastCalledWith(false);
  });

  it('preserves isLocalOffline and localFileUri on Popout detach and dock reconstruction', () => {
    const offlineTarget: PlayTarget = {
      itemKey: 'movie:s1:99',
      sourceId: 's1',
      title: 'Saved Film',
      kind: 'vod',
      itemKind: 'movie',
      isLocalOffline: true,
      localFileUri: 'file:///downloads/saved-film.mp4',
    };

    const launch = buildPopoutLaunchPayload(offlineTarget, 12_500);
    expect(launch).toMatchObject({
      itemKey: 'movie:s1:99',
      kind: 'movie',
      isLocalOffline: true,
      localFileUri: 'file:///downloads/saved-film.mp4',
      resumePositionMs: 12_500,
    });

    const docked = buildPlayTargetFromPopoutDock({
      itemKey: 'movie:s1:99',
      kind: 'movie',
      title: 'Saved Film',
      sourceId: 's1',
      positionMs: 25_000,
      isLocalOffline: true,
      localFileUri: 'file:///downloads/saved-film.mp4',
    });
    expect(docked).toMatchObject({
      itemKey: 'movie:s1:99',
      kind: 'vod',
      itemKind: 'movie',
      startPositionMs: 25_000,
      isLocalOffline: true,
      localFileUri: 'file:///downloads/saved-film.mp4',
    });

    const onlineLaunch = buildPopoutLaunchPayload({
      itemKey: 'live:s1:1',
      sourceId: 's1',
      title: 'Live Channel',
      kind: 'live',
      itemKind: 'live',
    });
    expect('isLocalOffline' in onlineLaunch).toBe(false);
    expect('localFileUri' in onlineLaunch).toBe(false);
  });
});

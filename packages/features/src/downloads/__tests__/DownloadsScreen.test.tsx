import { type DownloadManagerPort, type DownloadRecord, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { DownloadsProvider } from '../../shared';
import { DownloadsScreen } from '../DownloadsScreen';

function createMockManager(
  records: readonly DownloadRecord[],
  supported = true,
): DownloadManagerPort & {
  pauseMock: jest.Mock;
  resumeMock: jest.Mock;
  cancelMock: jest.Mock;
  removeMock: jest.Mock;
} {
  const pauseMock = jest.fn(async () => ok(undefined));
  const resumeMock = jest.fn(async () => ok(undefined));
  const cancelMock = jest.fn(async () => ok(undefined));
  const removeMock = jest.fn(async () => ok(undefined));
  return {
    supported,
    list: jest.fn(async () => records),
    get: jest.fn(async (key) => records.find((r) => r.itemKey === key) ?? null),
    enqueue: jest.fn(async () => ok(records[0] as DownloadRecord)),
    pause: pauseMock,
    resume: resumeMock,
    cancel: cancelMock,
    remove: removeMock,
    notifyOnlinePlaybackActive: jest.fn(),
    subscribe: jest.fn(() => () => {}),
    pauseMock,
    resumeMock,
    cancelMock,
    removeMock,
  };
}

async function wrap(
  manager: DownloadManagerPort | undefined,
  ui: ReactNode,
  opts?: {
    readonly isTv?: boolean;
    readonly dispatcher?: ReturnType<typeof createTvRemoteDispatcher>;
  },
) {
  const i18n = createAppI18n('en');
  const isTv = opts?.isTv ?? false;
  const content = (
    <ViewportProvider
      value={{
        width: 1280,
        height: 720,
        formFactor: isTv ? 'tv' : 'desktop',
        inputModality: isTv ? 'tv' : 'pointer',
      }}
    >
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <DownloadsProvider {...(manager !== undefined ? { manager } : {})}>
            {ui}
          </DownloadsProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
  return render(
    opts?.dispatcher ? (
      <TvRemoteProvider dispatcher={opts.dispatcher}>{content}</TvRemoteProvider>
    ) : (
      content
    ),
  );
}

describe('DownloadsScreen', () => {
  it('shows unsupported state when manager is unsupported and empty', async () => {
    const manager = createMockManager([], false);
    await wrap(manager, <DownloadsScreen onPlay={jest.fn()} />);
    expect(await screen.findByTestId('downloads-unsupported-state')).toBeTruthy();
  });

  it('shows constructive empty state when supported with no downloads', async () => {
    const manager = createMockManager([], true);
    await wrap(manager, <DownloadsScreen onPlay={jest.fn()} />);
    expect(await screen.findByTestId('downloads-empty-state')).toBeTruthy();
  });

  it('renders active queue and completed rows with offline playback, Multi-View, and delete controls', async () => {
    const activeRecord: DownloadRecord = {
      id: 'dl-1',
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'movie:src-1:10',
      kind: 'movie',
      title: 'Dune',
      localFileName: 'dune.mp4',
      localUri: null,
      bytesDownloaded: 250 * 1024 * 1024,
      totalBytes: 1000 * 1024 * 1024,
      status: 'paused',
      pausedForPlayback: true,
      createdAt: 1,
      updatedAt: 2,
    };
    const completedRecord: DownloadRecord = {
      id: 'dl-2',
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'ep:src-1:20',
      kind: 'episode',
      title: 'Pilot',
      seriesTitle: 'Andor',
      season: 1,
      episodeNum: 1,
      localFileName: 'andor-s1e1.mp4',
      localUri: 'file:///downloads/andor-s1e1.mp4',
      bytesDownloaded: 500 * 1024 * 1024,
      totalBytes: 500 * 1024 * 1024,
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    };

    const manager = createMockManager([activeRecord, completedRecord], true);
    const onPlay = jest.fn();
    const onOpenMultiView = jest.fn();
    await wrap(manager, <DownloadsScreen onPlay={onPlay} onOpenMultiView={onOpenMultiView} />);

    expect(await screen.findByTestId('downloads-storage-badge')).toBeTruthy();
    expect(screen.getByTestId('download-status-movie:src-1:10').props.children).toBe(
      'Paused while streaming',
    );

    await fireEvent.press(screen.getByTestId('download-toggle-movie:src-1:10'));
    await waitFor(() =>
      expect(manager.resumeMock).toHaveBeenCalledWith('movie:src-1:10', undefined),
    );

    await fireEvent.press(screen.getByTestId('download-cancel-movie:src-1:10'));
    await waitFor(() =>
      expect(manager.cancelMock).toHaveBeenCalledWith('movie:src-1:10', undefined),
    );

    await fireEvent.press(screen.getByTestId('download-play-ep:src-1:20'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'ep:src-1:20',
        isLocalOffline: true,
        localFileUri: 'file:///downloads/andor-s1e1.mp4',
      }),
    );

    onPlay.mockClear();
    await fireEvent.press(screen.getByTestId('download-multiview-ep:src-1:20'));
    expect(onOpenMultiView).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'ep:src-1:20',
        isLocalOffline: true,
      }),
    );
    expect(onPlay).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('download-delete-ep:src-1:20'));
    await waitFor(() => expect(manager.removeMock).toHaveBeenCalledWith('ep:src-1:20', undefined));
    expect(onPlay).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('download-completed-body-ep:src-1:20'));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('opens universal ContextMenu via TV menu key for active and completed rows', async () => {
    const activeRecord: DownloadRecord = {
      id: 'dl-tv-1',
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'movie:src-1:10',
      kind: 'movie',
      title: 'Dune',
      localFileName: 'dune.mp4',
      localUri: null,
      bytesDownloaded: 100,
      totalBytes: 1000,
      status: 'downloading',
      createdAt: 1,
      updatedAt: 2,
    };
    const completedRecord: DownloadRecord = {
      id: 'dl-tv-2',
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'movie:src-1:20',
      kind: 'movie',
      title: 'Arrival',
      localFileName: 'arrival.mp4',
      localUri: 'file:///downloads/arrival.mp4',
      bytesDownloaded: 1000,
      totalBytes: 1000,
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    };
    const manager = createMockManager([activeRecord, completedRecord], true);
    const dispatcher = createTvRemoteDispatcher();
    const onPlay = jest.fn();
    const onOpenMultiView = jest.fn();

    await wrap(manager, <DownloadsScreen onPlay={onPlay} onOpenMultiView={onOpenMultiView} />, {
      isTv: true,
      dispatcher,
    });
    await screen.findByTestId('download-active-row-movie:src-1:10');

    // Menu on focused active row -> Cancel
    await act(async () => {
      dispatcher.dispatch({ key: 'menu', action: 'press', time: 10 }, false);
    });
    await waitFor(() => expect(screen.getByTestId('downloads-context-cancel')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('downloads-context-cancel'));
    await waitFor(() =>
      expect(manager.cancelMock).toHaveBeenCalledWith('movie:src-1:10', undefined),
    );

    // Move down to completed row and press menu -> Delete
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 20 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'menu', action: 'press', time: 30 }, false);
    });
    await waitFor(() => {
      expect(screen.getByTestId('downloads-context-play')).toBeTruthy();
      expect(screen.getByTestId('downloads-context-multiview')).toBeTruthy();
      expect(screen.getByTestId('downloads-context-delete')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('downloads-context-delete'));
    await waitFor(() =>
      expect(manager.removeMock).toHaveBeenCalledWith('movie:src-1:20', undefined),
    );
  });
});

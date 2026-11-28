import type {
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  LiveFavoriteFolderRecord,
  SourceRow,
} from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';
import { CatalogUiCacheProvider, createCatalogUiCache, StreamHealthProvider } from '../../shared';
import * as desktopDialogTrap from '../../shared/desktop-dialog-trap';
import { LiveContextMenu } from '../LiveContextMenu';
import { LiveFavoriteFolderModal } from '../LiveFavoriteFolderModal';
import { LiveFavoriteFolderStrip } from '../LiveFavoriteFolderStrip';
import { LiveScreen } from '../LiveScreen';
import { useLiveFavoriteFolders } from '../useLiveFavoriteFolders';

function makeChannel(index: number, sourceId = 's1'): ItemRow {
  const num = 101 + index;
  return {
    id: index + 1,
    key: `x:${sourceId}:live:${num}`,
    kind: 'live',
    sourceId,
    providerId: String(num),
    name: `Channel ${num}`,
    logo: null,
    rating: null,
    year: null,
    num,
  };
}

function wrap(ui: ReactElement, cache = createCatalogUiCache()) {
  return (
    <CatalogUiCacheProvider cache={cache}>
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <ViewportProvider value={{ width: 1280, height: 800, formFactor: 'desktop' }}>
            {ui}
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>
    </CatalogUiCacheProvider>
  );
}

function FolderHookHarness({
  catalog,
  favoriteChannels,
  states,
}: {
  readonly catalog: CatalogService;
  readonly favoriteChannels: readonly ItemRow[];
  readonly states: Array<ReturnType<typeof useLiveFavoriteFolders>>;
}) {
  const state = useLiveFavoriteFolders({
    catalog,
    favoriteChannels,
    refreshToken: 0,
  });
  states.push(state);
  return null;
}

describe('Wave Q7-B LiveContextMenu Recent Remove & Move to Folder', () => {
  it('renders Remove from Recent when isRecent=true and Move to folder when wired', async () => {
    const ch = makeChannel(0);
    const onRemoveFromRecent = jest.fn();
    const onMoveToFolder = jest.fn();
    const onClose = jest.fn();

    const view = await render(
      wrap(
        <LiveContextMenu
          visible
          channel={ch}
          channelIndex={0}
          programme={null}
          isFavorite
          isRecent
          isTv={false}
          onPlay={jest.fn()}
          onRemoveFromRecent={onRemoveFromRecent}
          onMoveToFolder={onMoveToFolder}
          onClose={onClose}
        />,
      ),
    );

    const removeBtn = screen.getByTestId('live-context-remove-from-recent');
    const moveBtn = screen.getByTestId('live-context-move-to-folder');
    expect(removeBtn).toBeTruthy();
    expect(moveBtn).toBeTruthy();

    await fireEvent.press(removeBtn);
    expect(onRemoveFromRecent).toHaveBeenCalledTimes(1);

    await fireEvent.press(moveBtn);
    expect(onMoveToFolder).toHaveBeenCalledWith(ch);

    await view.unmount();
  });

  it('hides Remove from Recent when isRecent is false', async () => {
    const ch = makeChannel(0);
    const view = await render(
      wrap(
        <LiveContextMenu
          visible
          channel={ch}
          channelIndex={0}
          programme={null}
          isFavorite={false}
          isRecent={false}
          isTv={false}
          onPlay={jest.fn()}
          onRemoveFromRecent={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );

    expect(screen.queryByTestId('live-context-remove-from-recent')).toBeNull();
    await view.unmount();
  });
});

describe('Wave Q7-B LiveFavoriteFolderStrip & LiveFavoriteFolderModal', () => {
  const folders: readonly LiveFavoriteFolderRecord[] = [
    {
      id: 'lff_sports',
      profileId: 'default',
      name: 'Sports',
      sortOrder: 0,
      itemCount: 2,
      createdAt: 100,
      updatedAt: 100,
    },
    {
      id: 'lff_news',
      profileId: 'default',
      name: 'News',
      sortOrder: 1,
      itemCount: 1,
      createdAt: 200,
      updatedAt: 200,
    },
  ];

  it('renders borderless editorial folder tabs (All, Unfiled, custom folders), create button, and manage button for active custom folder', async () => {
    const onSelectFilter = jest.fn();
    const onRequestCreate = jest.fn();
    const onRequestManage = jest.fn();

    const view = await render(
      wrap(
        <LiveFavoriteFolderStrip
          folders={folders}
          activeFilter="lff_sports"
          isTv={false}
          onSelectFilter={onSelectFilter}
          onRequestCreate={onRequestCreate}
          onRequestManage={onRequestManage}
        />,
      ),
    );

    expect(screen.getByTestId('live-folder-tab-all')).toBeTruthy();
    expect(screen.getByTestId('live-folder-tab-unfiled')).toBeTruthy();
    expect(screen.getByTestId('live-folder-tab-lff_sports')).toBeTruthy();
    expect(screen.getByTestId('live-folder-tab-lff_news')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('live-folder-tab-unfiled'));
    expect(onSelectFilter).toHaveBeenCalledWith('unfiled');

    await fireEvent.press(screen.getByTestId('live-folder-create-btn'));
    expect(onRequestCreate).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('live-folder-manage-btn'));
    expect(onRequestManage).toHaveBeenCalledWith(folders[0]);

    await view.unmount();
  });

  it('supports moving a channel to an existing folder, Unfiled, or inline create-and-move', async () => {
    const ch = makeChannel(0);
    const onAssignFolder = jest.fn(async () => true);
    const onCreateFolder = jest.fn(async (name: string) => ({
      id: 'lff_created',
      profileId: 'default',
      name,
      sortOrder: 2,
      itemCount: 0,
      createdAt: 300,
      updatedAt: 300,
    }));
    const onClose = jest.fn();

    const view = await render(
      wrap(
        <LiveFavoriteFolderModal
          mode={{ kind: 'move', channel: ch }}
          folders={folders}
          currentFolderId="lff_sports"
          isTv={false}
          onAssignFolder={onAssignFolder}
          onCreateFolder={onCreateFolder}
          onRenameFolder={jest.fn(async () => true)}
          onDeleteFolder={jest.fn(async () => true)}
          onClose={onClose}
        />,
      ),
    );

    await act(async () => {
      await fireEvent.press(screen.getByTestId('live-folder-modal-option-lff_news'));
    });
    expect(onAssignFolder).toHaveBeenCalledWith(ch, 'lff_news');
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      await fireEvent.press(screen.getByTestId('live-folder-modal-option-unfiled'));
    });
    expect(onAssignFolder).toHaveBeenCalledWith(ch, null);

    // Inline create & move
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('live-folder-modal-name-input'), 'Kids');
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('live-folder-modal-submit'));
    });
    expect(onCreateFolder).toHaveBeenCalledWith('Kids');
    expect(onAssignFolder).toHaveBeenCalledWith(ch, 'lff_created');

    await view.unmount();
  });

  it('hydrates folders synchronously from CatalogUiCache with zero blink and filters favorite channels', async () => {
    const ch1 = makeChannel(0, 's1');
    const ch2 = makeChannel(1, 's2');
    const cache = createCatalogUiCache();
    cache.setLiveFavoriteFolders?.(folders, new Map([[ch1.key, 'lff_sports']]));

    const catalog = {
      listLiveFavoriteFolders: jest.fn(async () => [...folders]),
      listLiveFavoriteFolderAssignments: jest.fn(async () => [
        { itemKey: ch1.key, folderId: 'lff_sports' },
      ]),
      createLiveFavoriteFolder: jest.fn(async ({ name }) =>
        ok({
          id: 'lff_new',
          profileId: 'default',
          name,
          sortOrder: 2,
          itemCount: 0,
          createdAt: 400,
          updatedAt: 400,
        }),
      ),
      renameLiveFavoriteFolder: jest.fn(async (id, name) =>
        ok({
          id,
          profileId: 'default',
          name,
          sortOrder: 0,
          itemCount: 1,
          createdAt: 100,
          updatedAt: 500,
        }),
      ),
      deleteLiveFavoriteFolder: jest.fn(async () => ok(undefined)),
      assignLiveFavoriteFolder: jest.fn(async () => ok(undefined)),
    } as unknown as CatalogService;

    const states: Array<ReturnType<typeof useLiveFavoriteFolders>> = [];
    const view = await render(
      wrap(
        <FolderHookHarness catalog={catalog} favoriteChannels={[ch1, ch2]} states={states} />,
        cache,
      ),
    );

    // Frame 0 hydrated synchronously from CatalogUiCache!
    expect(states[0]?.folders).toHaveLength(2);
    expect(states[0]?.filteredFavoriteChannels.map((c) => c.key)).toEqual([ch1.key, ch2.key]);

    await act(async () => {
      states.at(-1)?.setActiveFolderFilter('lff_sports');
    });
    expect(states.at(-1)?.filteredFavoriteChannels.map((c) => c.key)).toEqual([ch1.key]);

    await act(async () => {
      states.at(-1)?.setActiveFolderFilter('unfiled');
    });
    expect(states.at(-1)?.filteredFavoriteChannels.map((c) => c.key)).toEqual([ch2.key]);

    // Move ch2 into lff_sports optimistically
    await act(async () => {
      await states.at(-1)?.moveChannelToFolder(ch2, 'lff_sports');
    });
    await waitFor(() => {
      expect(states.at(-1)?.assignmentByItemKey.get(ch2.key)).toBe('lff_sports');
    });

    await view.unmount();
  });

  it('wires LiveFavoriteFolderStrip inside LiveZapDrawer in LiveScreen and keeps drawer visible when filtering empty folders', async () => {
    const ch1 = makeChannel(0, 's1');
    const ch2 = makeChannel(1, 's1');
    const source: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Provider',
      createdAt: 100,
      needsImport: false,
    };
    const cat: CategoryRow = {
      id: 's1|live|all',
      sourceId: 's1',
      kind: 'live',
      name: 'All Live',
      position: 0,
      itemCount: 2,
    };
    const favRows: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: ch1.key,
        kind: 'live',
        title: ch1.name,
        logo: null,
        year: null,
        rating: null,
        addedAt: 100,
        sortOrder: 1,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: ch2.key,
        kind: 'live',
        title: ch2.name,
        logo: null,
        year: null,
        rating: null,
        addedAt: 200,
        sortOrder: 2,
      },
    ];
    const sportsFolder: LiveFavoriteFolderRecord = {
      id: 'lff_sports',
      profileId: 'default',
      name: 'Sports',
      sortOrder: 0,
      itemCount: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    const emptyFolder: LiveFavoriteFolderRecord = {
      id: 'lff_empty',
      profileId: 'default',
      name: 'Empty Folder',
      sortOrder: 1,
      itemCount: 0,
      createdAt: 200,
      updatedAt: 200,
    };
    const allFolders = [sportsFolder, emptyFolder];
    const deleteLiveFavoriteFolder = jest.fn(async () => ok(undefined));
    const catalog = {
      listSources: jest.fn(async () => [source]),
      categories: jest.fn(async () => [cat]),
      items: jest.fn(async () => [ch1, ch2]),
      nowNext: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => [ch1.key, ch2.key]),
      listFavorites: jest.fn(async () => favRows),
      itemDetail: jest.fn(async (key: string) => (key === ch1.key ? ch1 : ch2)),
      listLiveFavoriteFolders: jest.fn(async () => allFolders),
      listLiveFavoriteFolderAssignments: jest.fn(async () => [
        { itemKey: ch1.key, folderId: 'lff_sports' },
      ]),
      createLiveFavoriteFolder: jest.fn(async () => ok(emptyFolder)),
      renameLiveFavoriteFolder: jest.fn(async () => ok(sportsFolder)),
      deleteLiveFavoriteFolder,
      assignLiveFavoriteFolder: jest.fn(async () => ok(undefined)),
    } as unknown as CatalogService;

    const view = await render(
      wrap(
        <StreamHealthProvider>
          <LiveScreen
            catalog={catalog}
            sources={[source]}
            refreshToken={0}
            defaultLiveMode="favorites"
            onPlay={jest.fn()}
            onOpenSources={jest.fn()}
          />
        </StreamHealthProvider>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-favorite-folder-strip')).toBeTruthy();
      expect(screen.getByTestId('live-folder-tab-lff_sports')).toBeTruthy();
      expect(screen.getByTestId('live-folder-tab-lff_empty')).toBeTruthy();
    });

    // Selecting empty folder keeps LiveZapDrawer + folder strip visible with quiet inline empty text (NOT live-favorites-empty!)
    await fireEvent.press(screen.getByTestId('live-folder-tab-lff_empty'));
    await waitFor(() => {
      expect(screen.getByTestId('live-zap-drawer-empty')).toBeTruthy();
      expect(screen.queryByTestId('live-favorites-empty')).toBeNull();
      expect(screen.getByTestId('live-favorite-folder-strip')).toBeTruthy();
    });

    // Manage active custom folder -> two-step delete confirms warning and deletes folder
    await fireEvent.press(screen.getByTestId('live-folder-manage-btn'));
    expect(screen.getByTestId('live-favorite-folder-modal')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-folder-modal-delete'));
    expect(screen.getByTestId('live-folder-modal-delete-warning')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('live-folder-modal-delete'));
    });
    expect(deleteLiveFavoriteFolder).toHaveBeenCalledWith('lff_empty');

    await view.unmount();
  });

  it('MAJOR-9: LiveFavoriteFolderModal wires useDesktopDialogTrap, stops Escape propagation, sets web backdrop tabIndex=-1, and stays open with error on failed assign', async () => {
    const ch = makeChannel(0);
    const trapSpy = jest.spyOn(desktopDialogTrap, 'useDesktopDialogTrap');
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<
      string,
      (e: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => void
    >();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => void,
    ) => {
      listeners.set(type, fn);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (type: string) => {
      listeners.delete(type);
    };

    try {
      const onAssignFolder = jest.fn(async () => false);
      const onClose = jest.fn();
      const view = await render(
        wrap(
          <LiveFavoriteFolderModal
            mode={{ kind: 'move', channel: ch }}
            folders={folders}
            currentFolderId="lff_sports"
            isTv={false}
            onAssignFolder={onAssignFolder}
            onCreateFolder={jest.fn(async () => null)}
            onRenameFolder={jest.fn(async () => false)}
            onDeleteFolder={jest.fn(async () => false)}
            onClose={onClose}
          />,
        ),
      );

      // Focus trap is wired when visible on desktop
      expect(trapSpy).toHaveBeenCalledWith(expect.any(Object), true, onClose);
      // Backdrop keeps focusable=false and tabIndex=-1 on web
      const backdrop = screen.getByTestId('live-folder-modal-backdrop');
      expect(backdrop.props.focusable).toBe(false);
      expect(backdrop.props.tabIndex).toBe(-1);

      // Failed assign must NOT close modal and must render error feedback
      await act(async () => {
        await fireEvent.press(screen.getByTestId('live-folder-modal-option-lff_news'));
      });
      expect(onAssignFolder).toHaveBeenCalledWith(ch, 'lff_news');
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('live-folder-modal-error')).toBeTruthy();

      // Escape calls both preventDefault and stopPropagation and closes once
      const preventDefault = jest.fn();
      const stopPropagation = jest.fn();
      await act(async () => {
        listeners.get('keydown')?.({ key: 'Escape', preventDefault, stopPropagation });
      });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(stopPropagation).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
      trapSpy.mockRestore();
      jest.restoreAllMocks();
    }
  });

  it('MINOR-14: rollback does not clobber concurrent committed edits and restores activeFolderFilter when deleteFolder fails', async () => {
    const ch1 = makeChannel(0, 's1');
    const ch2 = makeChannel(1, 's1');
    let rejectRename!: (value: ReturnType<typeof err>) => void;
    const pendingRename = new Promise<ReturnType<typeof err>>((resolve) => {
      rejectRename = resolve;
    });
    const catalog = {
      listLiveFavoriteFolders: jest.fn(async () => [...folders]),
      listLiveFavoriteFolderAssignments: jest.fn(async () => [
        { itemKey: ch1.key, folderId: 'lff_sports' },
      ]),
      createLiveFavoriteFolder: jest.fn(async ({ name }) =>
        ok({
          id: 'lff_kids',
          profileId: 'default',
          name,
          sortOrder: 2,
          itemCount: 0,
          createdAt: 400,
          updatedAt: 400,
        }),
      ),
      renameLiveFavoriteFolder: jest.fn(() => pendingRename),
      deleteLiveFavoriteFolder: jest.fn(async () => err(elvError('storage', 'disk-full'))),
      assignLiveFavoriteFolder: jest.fn(async () => ok(undefined)),
    } as unknown as CatalogService;

    const states: Array<ReturnType<typeof useLiveFavoriteFolders>> = [];
    const view = await render(
      wrap(<FolderHookHarness catalog={catalog} favoriteChannels={[ch1, ch2]} states={states} />),
    );
    await waitFor(() => expect(states.at(-1)?.folders).toHaveLength(2));

    // Start rename of lff_sports (will fail) while concurrently creating lff_kids (succeeds)
    let renamePromise!: Promise<boolean>;
    await act(async () => {
      renamePromise =
        states.at(-1)?.renameFolder('lff_sports', 'Broken Rename') ?? Promise.resolve(false);
      await states.at(-1)?.createFolder('Kids');
    });
    expect(states.at(-1)?.folders.map((f) => f.id)).toContain('lff_kids');

    // Now fail the pending rename -> lff_sports reverts to 'Sports', BUT committed 'Kids' folder MUST remain!
    await act(async () => {
      rejectRename(err(elvError('storage', 'rename-failed')));
      await renamePromise;
    });
    expect(states.at(-1)?.folders.find((f) => f.id === 'lff_sports')?.name).toBe('Sports');
    expect(states.at(-1)?.folders.map((f) => f.id)).toContain('lff_kids');

    // Select lff_sports as active filter, then fail deleteFolder('lff_sports') -> activeFolderFilter MUST restore to 'lff_sports'!
    await act(async () => {
      states.at(-1)?.setActiveFolderFilter('lff_sports');
    });
    expect(states.at(-1)?.activeFolderFilter).toBe('lff_sports');

    await act(async () => {
      const okDel = await states.at(-1)?.deleteFolder('lff_sports');
      expect(okDel).toBe(false);
    });
    expect(states.at(-1)?.folders.some((f) => f.id === 'lff_sports')).toBe(true);
    expect(states.at(-1)?.activeFolderFilter).toBe('lff_sports');

    await view.unmount();
  });

  it('MAJOR-5: TV D-pad navigates from Live Favorites zap row 0 up into LiveFavoriteFolderStrip, left/right across tabs & +, OK selects folder, and down back to zap list', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const KEYCODE_DPAD_UP = 19;
    const KEYCODE_DPAD_DOWN = 20;
    const KEYCODE_DPAD_LEFT = 21;
    const KEYCODE_DPAD_RIGHT = 22;
    const KEYCODE_DPAD_CENTER = 23;
    const KEYCODE_BACK = 4;
    let listener: ((event: AndroidKeyEvent) => void) | null = null;
    const androidSource: AndroidKeySource = {
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

    const ch1 = makeChannel(0, 's1');
    const ch2 = makeChannel(1, 's1');
    const source: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Provider',
      createdAt: 100,
      needsImport: false,
    };
    const cat: CategoryRow = {
      id: 's1|live|all',
      sourceId: 's1',
      kind: 'live',
      name: 'All Live',
      position: 0,
      itemCount: 2,
    };
    const favRows: FavoriteRow[] = [ch1, ch2].map((ch, idx) => ({
      profileId: 'default',
      sourceId: 's1',
      itemKey: ch.key,
      kind: 'live',
      title: ch.name,
      logo: null,
      year: null,
      rating: null,
      addedAt: 100 + idx,
      sortOrder: idx + 1,
    }));
    const catalog = {
      listSources: jest.fn(async () => [source]),
      categories: jest.fn(async () => [cat]),
      items: jest.fn(async () => [ch1, ch2]),
      nowNext: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => [ch1.key, ch2.key]),
      listFavorites: jest.fn(async () => favRows),
      itemDetail: jest.fn(async (key: string) => (key === ch1.key ? ch1 : ch2)),
      listLiveFavoriteFolders: jest.fn(async () => [...folders]),
      listLiveFavoriteFolderAssignments: jest.fn(async () => [
        { itemKey: ch1.key, folderId: 'lff_sports' },
      ]),
      createLiveFavoriteFolder: jest.fn(async () => ok(folders[0])),
      renameLiveFavoriteFolder: jest.fn(async () => ok(folders[0])),
      deleteLiveFavoriteFolder: jest.fn(async () => ok(undefined)),
      assignLiveFavoriteFolder: jest.fn(async () => ok(undefined)),
    } as unknown as CatalogService;

    const view = await render(
      <CatalogUiCacheProvider cache={createCatalogUiCache()}>
        <RemoteKeysProvider android={androidSource}>
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider>
              <ViewportProvider
                value={{
                  width: 1920,
                  height: 1080,
                  formFactor: 'tv',
                  orientation: 'landscape',
                  inputModality: 'tv',
                }}
              >
                <StreamHealthProvider>
                  <LiveScreen
                    catalog={catalog}
                    sources={[source]}
                    refreshToken={0}
                    defaultLiveMode="favorites"
                    onPlay={jest.fn()}
                    onOpenSources={jest.fn()}
                  />
                </StreamHealthProvider>
              </ViewportProvider>
            </ThemeProvider>
          </I18nProvider>
        </RemoteKeysProvider>
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-favorite-folder-strip')).toBeTruthy();
      expect(screen.getByTestId('live-folder-tab-lff_sports')).toBeTruthy();
    });

    // Header (modes) -> Down into Zap row 0 -> Up from row 0 enters LiveFavoriteFolderStrip slot 0 ('All')
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_UP);
    // Right twice: slot 0 ('All') -> slot 1 ('Unfiled') -> slot 2 ('Sports')
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    // OK selects 'Sports' folder
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(
        screen.getByTestId('live-folder-tab-lff_sports').props.accessibilityState?.selected,
      ).toBe(true);
      // Only ch1 is in Sports -> manage button appears
      expect(screen.getByTestId('live-folder-manage-btn')).toBeTruthy();
    });

    // Press Down from folder strip returns to Zap row 0, then Up returns to folder strip
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_UP);
    // Move Right across News (3) -> Manage (4) -> Create '+' (5) and press OK to open Create Folder modal!
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(screen.getByTestId('live-favorite-folder-modal')).toBeTruthy();
    });

    // Close modal with Back, select empty folder 'News' (slot 3), verify strip stays D-pad reachable on empty folder!
    await sendKey(KEYCODE_BACK);
    await waitFor(() => {
      expect(screen.queryByTestId('live-favorite-folder-modal')).toBeNull();
    });
    await sendKey(KEYCODE_DPAD_LEFT);
    await sendKey(KEYCODE_DPAD_LEFT);
    await sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(
        screen.getByTestId('live-folder-tab-lff_news').props.accessibilityState?.selected,
      ).toBe(true);
      expect(screen.getByTestId('live-zap-drawer-empty')).toBeTruthy();
    });

    await view.unmount();
    jest.restoreAllMocks();
  });
});

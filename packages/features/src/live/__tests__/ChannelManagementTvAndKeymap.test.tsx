import {
  type CatalogService,
  type CustomGroupRecord,
  customGroupCategoryId,
  type ItemRow,
  type SourceRow,
} from '@elv/data';
import { createKeymapStore, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, ScrollView } from 'react-native';
import { KeymapProvider } from '../../shared';
import { ChannelManagementOverlay } from '../ChannelManagementOverlay';
import { LiveScreen } from '../LiveScreen';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_PROG_GREEN = 184;

const DEMO_SOURCE: SourceRow = {
  id: 's1',
  kind: 'm3u',
  name: 'Demo IPTV',
  createdAt: 1,
  needsImport: false,
};

function makeChannel(index: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: index,
    key: `m:s1:live:${index}`,
    kind: 'live',
    sourceId: 's1',
    providerId: String(index),
    name: `Channel ${index}`,
    logo: null,
    rating: null,
    year: null,
    num: index,
    ...overrides,
  };
}

function wrapProviders(
  node: ReactElement,
  opts?: { readonly isTv?: boolean; readonly androidSource?: AndroidKeySource },
): ReactElement {
  const isTv = opts?.isTv ?? false;
  const inner = (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor: isTv ? 'tv' : 'desktop',
          orientation: 'landscape',
          inputModality: isTv ? 'tv' : 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider preset="obsidianCrimson">{node}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
  return opts?.androidSource !== undefined ? (
    <RemoteKeysProvider android={opts.androidSource}>{inner}</RemoteKeysProvider>
  ) : (
    inner
  );
}

describe('ChannelManagementOverlay TV D-pad, multi-source reorder, custom-group 0-9 & Live keymap (#60, #33)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('supports full 2D 10-ft TV D-pad traversal & activation across Rename, Hide, Reorder, Group Picker, and Custom Groups (#60)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const scrollToSpy = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const tap = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 15 });
      });
    };

    let channels: ItemRow[] = [makeChannel(1), makeChannel(2)];
    let groups: CustomGroupRecord[] = [
      {
        id: 'g_sports',
        profileId: 'default',
        name: 'Sports',
        sortOrder: 0,
        isHidden: false,
        itemCount: 0,
        updatedAt: 100,
      },
    ];

    const setChannelOverride = jest.fn(async (input) => {
      channels = channels.map((ch) =>
        ch.key === input.itemKey
          ? {
              ...ch,
              ...(input.customName ? { name: input.customName, originalName: ch.name } : {}),
              ...(input.isHidden !== undefined ? { isHidden: input.isHidden } : {}),
            }
          : ch,
      );
      return ok({
        profileId: 'default',
        itemKey: input.itemKey,
        sourceId: input.sourceId,
        customName: input.customName ?? null,
        isHidden: input.isHidden ?? false,
        sortOrder: null,
        updatedAt: 200,
      });
    });
    const reorderChannels = jest.fn(async (keys: readonly string[]) => {
      const byKey = new Map(channels.map((c) => [c.key, c]));
      channels = keys.flatMap((k) => {
        const hit = byKey.get(k);
        return hit ? [hit] : [];
      });
      return ok(undefined);
    });
    const addChannelToCustomGroup = jest.fn(async () => ok(undefined));
    const createCustomGroup = jest.fn(async (input: { readonly name: string }) => {
      const rec: CustomGroupRecord = {
        id: 'g_movies',
        profileId: 'default',
        name: input.name,
        sortOrder: 1,
        isHidden: false,
        itemCount: 0,
        updatedAt: 200,
      };
      groups = [...groups, rec];
      return ok(rec);
    });
    const deleteCustomGroup = jest.fn(async (id: string) => {
      groups = groups.filter((g) => g.id !== id);
      return ok(undefined);
    });

    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      allSourcesItems: jest.fn(async () => channels),
      listCustomGroups: jest.fn(async () => groups),
      setChannelOverride,
      reorderChannels,
      addChannelToCustomGroup,
      createCustomGroup,
      deleteCustomGroup,
      resolveStream: jest.fn(),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(),
      episodes: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const onClose = jest.fn();
    await render(
      wrapProviders(
        <ChannelManagementOverlay
          visible
          catalog={catalog}
          sources={[DEMO_SOURCE]}
          onClose={onClose}
        />,
        { isTv: true, androidSource },
      ),
    );

    await waitFor(() => expect(screen.getByTestId('channel-manage-row-m:s1:live:1')).toBeTruthy());

    // Down enters row 0, col 0 ('rename'); ScrollView scrolls
    await tap(KEYCODE_DPAD_DOWN);
    expect(scrollToSpy).toHaveBeenCalled();

    // Select opens inline rename; Back cancels rename WITHOUT closing overlay
    await tap(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('channel-manage-rename-input-m:s1:live:1')).toBeTruthy();
    await tap(KEYCODE_BACK);
    expect(screen.queryByTestId('channel-manage-rename-input-m:s1:live:1')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Open rename again, edit text, Right to Save, Select saves
    await tap(KEYCODE_DPAD_CENTER);
    await fireEvent.changeText(
      screen.getByTestId('channel-manage-rename-input-m:s1:live:1'),
      'TV One',
    );
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() =>
      expect(setChannelOverride).toHaveBeenCalledWith({
        itemKey: 'm:s1:live:1',
        sourceId: 's1',
        customName: 'TV One',
      }),
    );

    // Row 0 now has ['rename', 'resetName', 'toggleHide', 'moveUp', 'moveDown', 'addToGroup']
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() =>
      expect(setChannelOverride).toHaveBeenCalledWith({
        itemKey: 'm:s1:live:1',
        sourceId: 's1',
        isHidden: true,
      }),
    );

    // Move right twice -> 'moveDown' (col 4), Select reorders channel 1 down
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() =>
      expect(reorderChannels).toHaveBeenCalledWith(['m:s1:live:2', 'm:s1:live:1'], 's1'),
    );

    // Move right -> 'addToGroup' (col 5), Select opens group picker; Back closes picker without closing overlay
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('channel-manage-group-picker-m:s1:live:1')).toBeTruthy();
    await tap(KEYCODE_BACK);
    expect(screen.queryByTestId('channel-manage-group-picker-m:s1:live:1')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Open group picker again and Select Sports group
    await tap(KEYCODE_DPAD_CENTER);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() =>
      expect(addChannelToCustomGroup).toHaveBeenCalledWith('g_sports', 'm:s1:live:1', 's1'),
    );

    // Navigate up to header (row 1 -> row 0 -> header), Right to Custom groups tab, Select
    await tap(KEYCODE_DPAD_UP);
    await tap(KEYCODE_DPAD_UP);
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('channel-manage-groups-tab-content')).toBeTruthy();

    // Down into create group row -> type name -> Right to New group -> Select creates group
    await tap(KEYCODE_DPAD_DOWN);
    await fireEvent.changeText(screen.getByTestId('channel-manage-new-group-input'), 'Movies');
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() => expect(createCustomGroup).toHaveBeenCalledWith({ name: 'Movies' }));

    // Down to Sports group header row -> Right to Delete (col 1 -> col 2) -> Select deletes Sports
    await tap(KEYCODE_DPAD_DOWN);
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() => expect(deleteCustomGroup).toHaveBeenCalledWith('g_sports'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reorders same-source channels across multi-source lists without colliding hidden sort_order (#60)', async () => {
    const source2: SourceRow = {
      id: 's2',
      kind: 'm3u',
      name: 'Second IPTV',
      createdAt: 2,
      needsImport: false,
    };
    const channels: ItemRow[] = [
      makeChannel(1),
      { ...makeChannel(10), key: 'm:s2:live:10', sourceId: 's2', name: 'Other Source' },
      makeChannel(2, { isHidden: true }),
      makeChannel(3),
    ];
    const reorderChannels = jest.fn(async () => ok(undefined));
    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE, source2]),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      allSourcesItems: jest.fn(async () => channels),
      listCustomGroups: jest.fn(async () => []),
      reorderChannels,
      resolveStream: jest.fn(),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(),
      episodes: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    await render(
      wrapProviders(
        <ChannelManagementOverlay
          visible
          catalog={catalog}
          sources={[DEMO_SOURCE, source2]}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('channel-manage-row-m:s1:live:1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('channel-manage-show-hidden'));
    expect(screen.queryByTestId('channel-manage-row-m:s1:live:2')).toBeNull();
    await fireEvent.press(screen.getByTestId('channel-manage-move-down-m:s1:live:1'));

    await waitFor(() => {
      expect(reorderChannels).toHaveBeenCalledWith(
        ['m:s1:live:3', 'm:s1:live:2', 'm:s1:live:1'],
        's1',
      );
    });
  });

  it('supports 0-9 channelByNumber inside custom groups, default colorGreen openHome, and keymap-routed web shortcut (#60, #33)', async () => {
    const channelByNumber = jest.fn(async () => makeChannel(1));
    const onOpenHome = jest.fn();
    const onPlay = jest.fn();

    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      categories: jest.fn(async () => [
        {
          id: 's1|live|general',
          sourceId: 's1',
          kind: 'live',
          name: 'General',
          position: 0,
          itemCount: 2,
        },
      ]),
      items: jest.fn(async () => [makeChannel(1), makeChannel(2)]),
      allSourcesItems: jest.fn(async () => [makeChannel(1), makeChannel(2)]),
      listCustomGroups: jest.fn(async () => [
        {
          id: 'g_fav',
          profileId: 'default',
          name: 'My Sports',
          sortOrder: 0,
          isHidden: false,
          itemCount: 2,
          updatedAt: 1,
        },
      ]),
      channelByNumber,
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      nowNext: jest.fn(async () => []),
      resolveStream: jest.fn(),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(),
      episodes: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };

    const tvView = await render(
      wrapProviders(
        <LiveScreen
          catalog={catalog}
          sources={[DEMO_SOURCE]}
          refreshToken={0}
          defaultLiveMode="channels"
          onPlay={onPlay}
          onOpenSources={jest.fn()}
          onOpenHome={onOpenHome}
        />,
        { isTv: true, androidSource },
      ),
    );

    await waitFor(() =>
      expect(screen.getByTestId('live-cat-chip-0')).toHaveTextContent('My Sports'),
    );

    // Green key triggers default global.openHome
    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_PROG_GREEN, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_PROG_GREEN, canceled: false, ageMs: 15 });
    });
    expect(onOpenHome).toHaveBeenCalledTimes(1);

    // 0-9 number jump inside synthetic custom group (sourceId: '') falls back to 's1'
    await fireEvent.press(screen.getByTestId('live-channels-numpad-toggle'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-1'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-↵'));
    await waitFor(() => {
      expect(channelByNumber).toHaveBeenCalledWith(1, 's1');
    });
    await tvView.unmount();

    // Web 'p' shortcut respects custom live.lastChannel keymap override
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);

    const webListeners: Array<(e: Record<string, unknown>) => void> = [];
    const origAdd = (globalThis as { addEventListener?: unknown }).addEventListener;
    const origRemove = (globalThis as { removeEventListener?: unknown }).removeEventListener;
    (globalThis as { addEventListener?: unknown }).addEventListener = (
      type: string,
      fn: (e: Record<string, unknown>) => void,
    ) => {
      if (type === 'keydown') webListeners.push(fn);
    };
    (globalThis as { removeEventListener?: unknown }).removeEventListener = (
      type: string,
      fn: (e: Record<string, unknown>) => void,
    ) => {
      if (type === 'keydown') {
        const idx = webListeners.indexOf(fn);
        if (idx >= 0) webListeners.splice(idx, 1);
      }
    };

    try {
      const kv = new Map<string, string>();
      const store = createKeymapStore({
        get: async (k) => kv.get(k),
        set: async (k, v) => {
          kv.set(k, v);
        },
        delete: async (k) => {
          kv.delete(k);
        },
      });
      await store.setOverrides({ 'live.lastChannel': { key: 'colorBlue', kind: 'press' } });

      onPlay.mockClear();
      await render(
        wrapProviders(
          <KeymapProvider keymapStore={store}>
            <LiveScreen
              catalog={catalog}
              sources={[DEMO_SOURCE]}
              refreshToken={0}
              defaultLiveMode="channels"
              memory={{
                mode: 'channels',
                categoryId: customGroupCategoryId('g_fav'),
                activeChannelKey: 'm:s1:live:1',
                previousChannelKey: 'm:s1:live:2',
                zapDrawerOpen: false,
              }}
              onPlay={onPlay}
              onOpenSources={jest.fn()}
            />
          </KeymapProvider>,
        ),
      );
      await waitFor(() => expect(screen.getByTestId('live-previous-channel-btn')).toBeTruthy());

      await act(async () => {
        for (const fn of [...webListeners]) fn({ key: 'p', preventDefault: jest.fn() });
      });
      expect(onPlay).not.toHaveBeenCalled();

      await act(async () => {
        for (const fn of [...webListeners]) fn({ key: 'b', preventDefault: jest.fn() });
      });
      expect(onPlay).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { addEventListener?: unknown }).addEventListener = origAdd;
      (globalThis as { removeEventListener?: unknown }).removeEventListener = origRemove;
    }
  });
});

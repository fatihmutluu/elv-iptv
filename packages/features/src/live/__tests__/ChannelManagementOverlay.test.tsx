import {
  type CatalogService,
  type CustomGroupRecord,
  customGroupCategoryId,
  type ItemRow,
  type SourceRow,
} from '@elv/data';
import { ok } from '@elv/domain';
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
import { Platform } from 'react-native';
import { ChannelManagementOverlay } from '../ChannelManagementOverlay';
import { LiveScreen } from '../LiveScreen';

const KEYCODE_BACK = 4;

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

describe('ChannelManagementOverlay & LiveScreen custom groups (#60)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renames, resets, hides/unhides, reorders channels, and manages custom groups', async () => {
    let channels: ItemRow[] = [
      makeChannel(1),
      makeChannel(2, { isHidden: true }),
      makeChannel(3, { name: 'Custom 3', originalName: 'Channel 3' }),
    ];
    let groups: CustomGroupRecord[] = [
      {
        id: 'g_sports',
        profileId: 'default',
        name: 'Sports',
        sortOrder: 0,
        isHidden: false,
        itemCount: 1,
        updatedAt: 100,
      },
    ];
    let groupMembers: ItemRow[] = [makeChannel(1)];

    const setChannelOverride = jest.fn(async (input) => {
      channels = channels.map((ch) => {
        if (ch.key !== input.itemKey) return ch;
        const nextName =
          input.customName === undefined
            ? ch.name
            : input.customName === null
              ? (ch.originalName ?? ch.name)
              : input.customName;
        return {
          ...ch,
          name: nextName,
          ...(input.customName === null ? { originalName: undefined } : {}),
          ...(input.isHidden !== undefined ? { isHidden: input.isHidden } : {}),
        };
      });
      return ok({
        profileId: 'default',
        itemKey: input.itemKey,
        sourceId: input.sourceId,
        customName: input.customName ?? null,
        isHidden: input.isHidden ?? false,
        sortOrder: input.sortOrder ?? null,
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
    const createCustomGroup = jest.fn(async (input: { readonly name: string }) => {
      const rec: CustomGroupRecord = {
        id: 'g_news',
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
    const updateCustomGroup = jest.fn(
      async (groupId: string, patch: { readonly name?: string }) => {
        groups = groups.map((g) => (g.id === groupId ? { ...g, name: patch.name ?? g.name } : g));
        const updated = groups.find((g) => g.id === groupId) ?? {
          id: groupId,
          profileId: 'default',
          name: patch.name ?? '',
          sortOrder: 0,
          isHidden: false,
          itemCount: 0,
          updatedAt: 200,
        };
        return ok(updated);
      },
    );
    const deleteCustomGroup = jest.fn(async (groupId: string) => {
      groups = groups.filter((g) => g.id !== groupId);
      return ok(undefined);
    });
    const addChannelToCustomGroup = jest.fn(async () => ok(undefined));
    const removeChannelFromCustomGroup = jest.fn(async (_groupId: string, itemKey: string) => {
      groupMembers = groupMembers.filter((m) => m.key !== itemKey);
      return ok(undefined);
    });

    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      categories: jest.fn(async () => []),
      items: jest.fn(async (catId: string) =>
        catId === customGroupCategoryId('g_sports') ? groupMembers : channels,
      ),
      allSourcesItems: jest.fn(async () => channels),
      listCustomGroups: jest.fn(async () => groups),
      setChannelOverride,
      reorderChannels,
      createCustomGroup,
      updateCustomGroup,
      deleteCustomGroup,
      addChannelToCustomGroup,
      removeChannelFromCustomGroup,
      resolveStream: jest.fn(),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(),
      episodes: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const onMutated = jest.fn();
    const onClose = jest.fn();

    await render(
      wrapProviders(
        <ChannelManagementOverlay
          visible
          catalog={catalog}
          sources={[DEMO_SOURCE]}
          onMutated={onMutated}
          onClose={onClose}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('channel-manage-row-m:s1:live:1')).toBeTruthy();
      expect(screen.getByTestId('channel-manage-hidden-badge-m:s1:live:2')).toBeTruthy();
    });

    // Toggle "Show hidden channels" hides hidden channel 2 from list
    await fireEvent.press(screen.getByTestId('channel-manage-show-hidden'));
    expect(screen.queryByTestId('channel-manage-row-m:s1:live:2')).toBeNull();
    await fireEvent.press(screen.getByTestId('channel-manage-show-hidden'));
    expect(screen.getByTestId('channel-manage-row-m:s1:live:2')).toBeTruthy();

    // Rename channel 1
    await fireEvent.press(screen.getByTestId('channel-manage-rename-m:s1:live:1'));
    await fireEvent.changeText(
      screen.getByTestId('channel-manage-rename-input-m:s1:live:1'),
      'Premier TV',
    );
    await fireEvent.press(screen.getByTestId('channel-manage-rename-save-m:s1:live:1'));
    await waitFor(() => {
      expect(setChannelOverride).toHaveBeenCalledWith({
        itemKey: 'm:s1:live:1',
        sourceId: 's1',
        customName: 'Premier TV',
      });
    });

    // Reset name on channel 3
    await fireEvent.press(screen.getByTestId('channel-manage-reset-name-m:s1:live:3'));
    await waitFor(() => {
      expect(setChannelOverride).toHaveBeenCalledWith({
        itemKey: 'm:s1:live:3',
        sourceId: 's1',
        customName: null,
      });
    });

    // Unhide channel 2
    await fireEvent.press(screen.getByTestId('channel-manage-toggle-hide-m:s1:live:2'));
    await waitFor(() => {
      expect(setChannelOverride).toHaveBeenCalledWith({
        itemKey: 'm:s1:live:2',
        sourceId: 's1',
        isHidden: false,
      });
    });

    // Move channel 1 down
    await fireEvent.press(screen.getByTestId('channel-manage-move-down-m:s1:live:1'));
    await waitFor(() => {
      expect(reorderChannels).toHaveBeenCalledWith(
        ['m:s1:live:2', 'm:s1:live:1', 'm:s1:live:3'],
        's1',
      );
    });

    // Add channel 1 to Sports group
    await fireEvent.press(screen.getByTestId('channel-manage-add-to-group-m:s1:live:1'));
    await fireEvent.press(screen.getByTestId('channel-manage-pick-group-m:s1:live:1-g_sports'));
    await waitFor(() => {
      expect(addChannelToCustomGroup).toHaveBeenCalledWith('g_sports', 'm:s1:live:1', 's1');
    });

    // Switch to Custom groups tab -> create, rename, expand/remove member, delete
    await fireEvent.press(screen.getByTestId('channel-manage-tab-groups'));
    await fireEvent.changeText(screen.getByTestId('channel-manage-new-group-input'), 'News');
    await fireEvent.press(screen.getByTestId('channel-manage-add-group-btn'));
    await waitFor(() => {
      expect(createCustomGroup).toHaveBeenCalledWith({ name: 'News' });
    });

    await fireEvent.press(screen.getByTestId('channel-manage-expand-group-g_sports'));
    await waitFor(() => {
      expect(screen.getByTestId('channel-manage-remove-member-g_sports-m:s1:live:1')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('channel-manage-remove-member-g_sports-m:s1:live:1'));
    await waitFor(() => {
      expect(removeChannelFromCustomGroup).toHaveBeenCalledWith('g_sports', 'm:s1:live:1');
    });

    await fireEvent.press(screen.getByTestId('channel-manage-edit-group-g_sports'));
    await fireEvent.changeText(
      screen.getByTestId('channel-manage-edit-group-input-g_sports'),
      'Live Sports',
    );
    await fireEvent.press(screen.getByTestId('channel-manage-save-group-g_sports'));
    await waitFor(() => {
      expect(updateCustomGroup).toHaveBeenCalledWith('g_sports', { name: 'Live Sports' });
    });

    await fireEvent.press(screen.getByTestId('channel-manage-delete-group-g_news'));
    await waitFor(() => {
      expect(deleteCustomGroup).toHaveBeenCalledWith('g_news');
    });
    expect(onMutated).toHaveBeenCalled();
  });

  it('dismisses cleanly on TV Back press via useTvKeyInterceptor and surfaces custom groups in LiveScreen', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const onClose = jest.fn();

    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      categories: jest.fn(async () => [
        {
          id: 's1|live|general',
          sourceId: 's1',
          kind: 'live',
          name: 'General',
          position: 0,
          itemCount: 1,
        },
      ]),
      items: jest.fn(async () => [makeChannel(1)]),
      allSourcesItems: jest.fn(async () => [makeChannel(1)]),
      listCustomGroups: jest.fn(async () => [
        {
          id: 'g_fav',
          profileId: 'default',
          name: 'My Sports',
          sortOrder: 0,
          isHidden: false,
          itemCount: 1,
          updatedAt: 1,
        },
      ]),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      setChannelOverride: jest.fn(async () =>
        ok({
          profileId: 'default',
          itemKey: 'm:s1:live:1',
          sourceId: 's1',
          customName: null,
          isHidden: true,
          sortOrder: null,
          updatedAt: 1,
        }),
      ),
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

    const overlayView = await render(
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
    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await overlayView.unmount();

    await render(
      wrapProviders(
        <LiveScreen
          catalog={catalog}
          sources={[DEMO_SOURCE]}
          refreshToken={0}
          defaultLiveMode="channels"
          onPlay={jest.fn()}
          onOpenSources={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-cat-chip-0')).toHaveTextContent('My Sports');
      expect(screen.getByTestId('live-cat-chip-1')).toHaveTextContent('General');
    });
  });
});

import type {
  CatalogService,
  FailoverGroupRecord,
  ItemRow,
  SourceRow,
  SuggestedFailoverCluster,
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
import { Platform, ScrollView } from 'react-native';
import { ChannelManagementOverlay } from '../ChannelManagementOverlay';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const SOURCE_A: SourceRow = {
  id: 's1',
  kind: 'm3u',
  name: 'Alpha TV',
  createdAt: 1,
  needsImport: false,
};

const SOURCE_B: SourceRow = {
  id: 's2',
  kind: 'xtream',
  name: 'Beta Stream',
  createdAt: 2,
  needsImport: false,
};

function makeChannel(
  sourceId: string,
  index: number,
  name: string,
  overrides: Partial<ItemRow> = {},
): ItemRow {
  return {
    id: index,
    key: `m:${sourceId}:live:${index}`,
    kind: 'live',
    sourceId,
    providerId: String(index),
    name,
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

function createFailoverCatalogHarness(opts?: {
  readonly initialGroups?: FailoverGroupRecord[];
  readonly suggestions?: SuggestedFailoverCluster[];
  readonly channels?: ItemRow[];
}) {
  const channels = opts?.channels ?? [
    makeChannel('s1', 1, 'Sports 1 HD'),
    makeChannel('s2', 1, 'Sports 1 FHD'),
    makeChannel('s1', 2, 'News 24'),
    makeChannel('s2', 2, 'News 24 Backup'),
  ];
  let groups: FailoverGroupRecord[] = opts?.initialGroups ? [...opts.initialGroups] : [];
  let suggestions: SuggestedFailoverCluster[] = opts?.suggestions ? [...opts.suggestions] : [];

  const listFailoverGroups = jest.fn(async () => groups);
  const suggestFailoverGroups = jest.fn(async () => suggestions);
  const applySuggestedFailoverGroups = jest.fn(
    async (clusters: readonly SuggestedFailoverCluster[]) => {
      const created: FailoverGroupRecord[] = clusters.map((c, idx) => ({
        id: `fg_auto_${idx + 1}`,
        name: c.suggestedName,
        autoMatched: true,
        createdAt: 100 + idx,
        updatedAt: 100 + idx,
        members: c.members.map((m, pos) => ({
          groupId: `fg_auto_${idx + 1}`,
          sourceId: m.sourceId,
          channelKey: m.channelKey,
          position: pos,
          channelName: m.channelName,
          sourceName: m.sourceName,
        })),
      }));
      groups = [...groups, ...created];
      suggestions = [];
      return ok(created);
    },
  );
  const createFailoverGroup = jest.fn(async (input: { readonly name: string }) => {
    const rec: FailoverGroupRecord = {
      id: `fg_manual_${groups.length + 1}`,
      name: input.name,
      autoMatched: false,
      createdAt: 200,
      updatedAt: 200,
      members: [],
    };
    groups = [...groups, rec];
    return ok(rec);
  });
  const deleteFailoverGroup = jest.fn(async (groupId: string) => {
    groups = groups.filter((g) => g.id !== groupId);
    return ok(undefined);
  });
  const addFailoverGroupMember = jest.fn(async (groupId: string, channelKey: string) => {
    const ch = channels.find((c) => c.key === channelKey);
    let updated: FailoverGroupRecord | undefined;
    groups = groups.map((g) => {
      if (g.id !== groupId) return g;
      const next: FailoverGroupRecord = {
        ...g,
        members: [
          ...g.members,
          {
            groupId,
            sourceId: ch?.sourceId ?? 's1',
            channelKey,
            position: g.members.length,
            ...(ch !== undefined ? { channelName: ch.name } : {}),
            sourceName: ch?.sourceId === 's2' ? SOURCE_B.name : SOURCE_A.name,
          },
        ],
      };
      updated = next;
      return next;
    });
    return ok(updated as FailoverGroupRecord);
  });
  const removeFailoverGroupMember = jest.fn(async (groupId: string, channelKey: string) => {
    let updated: FailoverGroupRecord | undefined;
    groups = groups.map((g) => {
      if (g.id !== groupId) return g;
      const next: FailoverGroupRecord = {
        ...g,
        members: g.members
          .filter((m) => m.channelKey !== channelKey)
          .map((m, pos) => ({ ...m, position: pos })),
      };
      updated = next;
      return next;
    });
    return ok(updated as FailoverGroupRecord);
  });
  const reorderFailoverGroupMembers = jest.fn(
    async (groupId: string, orderedChannelKeys: readonly string[]) => {
      let updated: FailoverGroupRecord | undefined;
      groups = groups.map((g) => {
        if (g.id !== groupId) return g;
        const byKey = new Map(g.members.map((m) => [m.channelKey, m]));
        const next: FailoverGroupRecord = {
          ...g,
          members: orderedChannelKeys.flatMap((k, pos) => {
            const hit = byKey.get(k);
            return hit ? [{ ...hit, position: pos }] : [];
          }),
        };
        updated = next;
        return next;
      });
      return ok(updated as FailoverGroupRecord);
    },
  );

  const catalog = {
    listSources: jest.fn(async () => [SOURCE_A, SOURCE_B]),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => channels),
    allSourcesItems: jest.fn(async () => channels),
    listCustomGroups: jest.fn(async () => []),
    listFailoverGroups,
    suggestFailoverGroups,
    applySuggestedFailoverGroups,
    createFailoverGroup,
    deleteFailoverGroup,
    addFailoverGroupMember,
    removeFailoverGroupMember,
    reorderFailoverGroupMembers,
    resolveStream: jest.fn(),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    seasons: jest.fn(),
    episodes: jest.fn(),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;

  return {
    catalog,
    channels,
    listFailoverGroups,
    suggestFailoverGroups,
    applySuggestedFailoverGroups,
    createFailoverGroup,
    deleteFailoverGroup,
    addFailoverGroupMember,
    removeFailoverGroupMember,
    reorderFailoverGroupMembers,
  };
}

describe('FailoverGroupsTab & ChannelManagementOverlay failover tab (#157)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('auto-matches cross-source clusters, applies suggestions, creates/deletes groups, adds/removes members, and reorders priority', async () => {
    const cluster: SuggestedFailoverCluster = {
      normalizedKey: 'sports 1',
      suggestedName: 'Sports 1',
      matchReason: 'name',
      members: [
        {
          sourceId: 's1',
          channelKey: 'm:s1:live:1',
          channelName: 'Sports 1 HD',
          sourceName: 'Alpha TV',
        },
        {
          sourceId: 's2',
          channelKey: 'm:s2:live:1',
          channelName: 'Sports 1 FHD',
          sourceName: 'Beta Stream',
        },
      ],
    };
    const harness = createFailoverCatalogHarness({ suggestions: [cluster] });
    const onMutated = jest.fn();

    await render(
      wrapProviders(
        <ChannelManagementOverlay
          visible
          catalog={harness.catalog}
          sources={[SOURCE_A, SOURCE_B]}
          onMutated={onMutated}
          onClose={jest.fn()}
        />,
      ),
    );

    // Open 3rd tab: Failover
    await fireEvent.press(screen.getByTestId('channel-manage-tab-failover'));
    await waitFor(() => {
      expect(screen.getByTestId('failover-groups-tab-content')).toBeTruthy();
      expect(screen.getByTestId('failover-groups-empty')).toBeTruthy();
    });

    // Auto-match discovers cluster and 1-click Apply creates group
    await fireEvent.press(screen.getByTestId('failover-auto-match-btn'));
    await waitFor(() => {
      expect(harness.suggestFailoverGroups).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('failover-suggestion-sports 1')).toBeTruthy();
      expect(screen.getByTestId('failover-apply-suggestions-btn')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('failover-apply-suggestions-btn'));
    await waitFor(() => {
      expect(harness.applySuggestedFailoverGroups).toHaveBeenCalledWith([cluster]);
      expect(screen.getByTestId('failover-group-card-fg_auto_1')).toBeTruthy();
      expect(screen.getByTestId('failover-member-primary-fg_auto_1-m:s1:live:1')).toBeTruthy();
    });

    // Move second member UP -> reorders priority so s2 becomes #1
    await fireEvent.press(screen.getByTestId('failover-member-up-fg_auto_1-m:s2:live:1'));
    await waitFor(() => {
      expect(harness.reorderFailoverGroupMembers).toHaveBeenCalledWith('fg_auto_1', [
        'm:s2:live:1',
        'm:s1:live:1',
      ]);
    });

    // Move now-first member DOWN -> restores s1 as #1
    await fireEvent.press(screen.getByTestId('failover-member-down-fg_auto_1-m:s2:live:1'));
    await waitFor(() => {
      expect(harness.reorderFailoverGroupMembers).toHaveBeenCalledWith('fg_auto_1', [
        'm:s1:live:1',
        'm:s2:live:1',
      ]);
    });

    // Open Add Channel picker -> add News 24 -> remove News 24
    await fireEvent.press(screen.getByTestId('failover-add-channel-btn-fg_auto_1'));
    await waitFor(() => {
      expect(screen.getByTestId('failover-pick-channel-fg_auto_1-m:s1:live:2')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('failover-pick-channel-fg_auto_1-m:s1:live:2'));
    await waitFor(() => {
      expect(harness.addFailoverGroupMember).toHaveBeenCalledWith('fg_auto_1', 'm:s1:live:2');
      expect(screen.getByTestId('failover-member-row-fg_auto_1-m:s1:live:2')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('failover-member-remove-fg_auto_1-m:s1:live:2'));
    await waitFor(() => {
      expect(harness.removeFailoverGroupMember).toHaveBeenCalledWith('fg_auto_1', 'm:s1:live:2');
    });

    // Create manual group & delete it
    await fireEvent.changeText(screen.getByTestId('failover-new-group-input'), 'World News');
    await fireEvent.press(screen.getByTestId('failover-create-group-btn'));
    await waitFor(() => {
      expect(harness.createFailoverGroup).toHaveBeenCalledWith({ name: 'World News' });
      expect(screen.getByTestId('failover-group-card-fg_manual_2')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('failover-delete-group-btn-fg_manual_2'));
    await waitFor(() => {
      expect(harness.deleteFailoverGroup).toHaveBeenCalledWith('fg_manual_2');
      expect(screen.queryByTestId('failover-group-card-fg_manual_2')).toBeNull();
    });

    // Running auto-match when none left displays no-suggestions notice
    await fireEvent.press(screen.getByTestId('failover-auto-match-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('failover-no-suggestions')).toBeTruthy();
    });
    expect(onMutated).toHaveBeenCalled();
  });

  it('supports full 2D TV D-pad navigation (Up/Down/Left/Right/Select/Back) without focus traps (#157)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});

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
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 12 });
      });
    };

    const existingGroup: FailoverGroupRecord = {
      id: 'fg_tv',
      name: 'Sports 1',
      autoMatched: false,
      createdAt: 100,
      updatedAt: 100,
      members: [
        {
          groupId: 'fg_tv',
          sourceId: 's1',
          channelKey: 'm:s1:live:1',
          position: 0,
          channelName: 'Sports 1 HD',
          sourceName: 'Alpha TV',
        },
        {
          groupId: 'fg_tv',
          sourceId: 's2',
          channelKey: 'm:s2:live:1',
          position: 1,
          channelName: 'Sports 1 FHD',
          sourceName: 'Beta Stream',
        },
      ],
    };
    const harness = createFailoverCatalogHarness({ initialGroups: [existingGroup] });
    const onClose = jest.fn();

    await render(
      wrapProviders(
        <ChannelManagementOverlay
          visible
          catalog={harness.catalog}
          sources={[SOURCE_A, SOURCE_B]}
          onClose={onClose}
        />,
        { isTv: true, androidSource },
      ),
    );

    // Header starts on tab-channels (col 0) -> Right -> tab-groups (col 1) -> Right -> tab-failover (col 2) -> Select
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('failover-groups-tab-content')).toBeTruthy();
      expect(screen.getByTestId('failover-group-card-fg_tv')).toBeTruthy();
    });

    // Down enters FailoverGroupsTab row 0 (auto-match)
    await tap(KEYCODE_DPAD_DOWN);
    // Down to row 1 (create), Down to row 2 (group header: addChannel | delete)
    await tap(KEYCODE_DPAD_DOWN);
    await tap(KEYCODE_DPAD_DOWN);
    // Select on col 0 opens channel picker; Back closes picker WITHOUT closing overlay
    await tap(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('failover-channel-picker-fg_tv')).toBeTruthy();
    await tap(KEYCODE_BACK);
    expect(screen.queryByTestId('failover-channel-picker-fg_tv')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Down to member 0 (col 0 = moveUp, col 1 = moveDown, col 2 = remove) -> Right -> moveDown -> Select
    await tap(KEYCODE_DPAD_DOWN);
    await tap(KEYCODE_DPAD_RIGHT);
    await tap(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(harness.reorderFailoverGroupMembers).toHaveBeenCalledWith('fg_tv', [
        'm:s2:live:1',
        'm:s1:live:1',
      ]);
    });

    // Left returns to col 0, Up x4 returns cleanly to overlay header (no trap)
    await tap(KEYCODE_DPAD_LEFT);
    await tap(KEYCODE_DPAD_UP);
    await tap(KEYCODE_DPAD_UP);
    await tap(KEYCODE_DPAD_UP);
    await tap(KEYCODE_DPAD_UP);

    // Back now closes the overlay
    await tap(KEYCODE_BACK);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

import type { CatalogService, CustomGroupRecord, ItemRow, SourceRow } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  FilterChip,
  TextEntryBoundary,
  TvFocusAnchor,
  type TvTextInputInstance,
  useI18n,
  useTextEntrySuspension,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { ChannelGroupsManagerTab } from './ChannelGroupsManagerTab';
import { ChannelManagementRow } from './ChannelManagementRow';
import { channelManagementOverlayStyles as styles } from './ChannelManagementStyles';
import {
  buildChannelRowActions,
  buildOverlayHeaderControls,
  type ChannelManageTab,
  canMoveChannelInSource,
  computeSameSourceReorder,
} from './channel-management-model';
import { FailoverGroupsTab } from './FailoverGroupsTab';

const MAX_MANAGED_CHANNELS = 200;
const NOOP_TV_SUBSCRIBER = (): boolean => false;

/** Props of {@link ChannelManagementOverlay}. */
export interface ChannelManagementOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly initialTab?: ChannelManageTab;
  readonly onMutated?: () => void;
  readonly onClose: () => void;
}

function OverlayTvKeyTrap({
  onBack,
  onNavigate,
}: {
  readonly onBack: () => void;
  readonly onNavigate: (key: KeyInput['key']) => void;
}): ReactElement {
  const textEntry = useTextEntrySuspension();
  const callbacksRef = useRef({ onBack, onNavigate });
  callbacksRef.current = { onBack, onNavigate };

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    if (textEntry.isActive()) {
      return false;
    }
    if (input.action !== 'down' && input.action !== 'press') return true;
    if (input.key === 'back') {
      callbacksRef.current.onBack();
      return true;
    }
    callbacksRef.current.onNavigate(input.key);
    return true;
  });

  return <TvFocusAnchor testID="channel-manage-tv-focus-anchor" hasTVPreferredFocus />;
}

async function fetchManagedChannels(
  catalog: CatalogService,
  sources: readonly SourceRow[],
): Promise<ItemRow[]> {
  const readyIds = sources.filter((s) => !s.needsImport).map((s) => s.id);
  if (catalog.allSourcesItems !== undefined) {
    return catalog
      .allSourcesItems(
        'live',
        0,
        MAX_MANAGED_CHANNELS,
        readyIds.length > 0 ? readyIds : undefined,
        { includeHidden: true },
      )
      .catch(() => [] as ItemRow[]);
  }
  const collected: ItemRow[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.needsImport) continue;
    const cats = await catalog.categories(source.id, 'live').catch(() => []);
    for (const cat of cats) {
      const rows = await catalog
        .items(cat.id, 0, MAX_MANAGED_CHANNELS, { includeHidden: true })
        .catch(() => [] as ItemRow[]);
      for (const row of rows) {
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        collected.push(row);
        if (collected.length >= MAX_MANAGED_CHANNELS) return collected;
      }
    }
  }
  return collected;
}

function ChannelManagementOverlayBody({
  visible,
  catalog,
  sources,
  initialTab = 'channels',
  onMutated,
  onClose,
}: ChannelManagementOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const profile = useProfile();
  const parentalLocked = profile.hasGuardPin && !profile.parentalUnlocked;
  const isTv = viewport.formFactor === 'tv';

  const [tab, setTab] = useState<ChannelManageTab>(initialTab);
  const [showHidden, setShowHidden] = useState(true);
  const [channels, setChannels] = useState<readonly ItemRow[]>([]);
  const [groups, setGroups] = useState<readonly CustomGroupRecord[]>([]);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameCol, setRenameCol] = useState<0 | 1 | 2>(0);
  const [groupPickerKey, setGroupPickerKey] = useState<string | null>(null);
  const [groupPickerIdx, setGroupPickerIdx] = useState(0);
  const [tvZone, setTvZone] = useState<'header' | 'body'>('header');
  const [headerCol, setHeaderCol] = useState(0);
  const [focusedRowIdx, setFocusedRowIdx] = useState(0);
  const [focusedActionCol, setFocusedActionCol] = useState(0);
  const [busy, setBusy] = useState(false);

  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const rowYRef = useRef<Record<number, number>>({});
  const renameInputRef = useRef<TvTextInputInstance | null>(null);
  const groupsTvHandlerRef = useRef<((key: KeyInput['key']) => boolean) | null>(null);
  const failoverTvHandlerRef = useRef<((key: KeyInput['key']) => boolean) | null>(null);

  useEffect(() => {
    if (visible && parentalLocked) {
      onClose();
    }
  }, [onClose, parentalLocked, visible]);

  const loadAll = useCallback(async () => {
    const [loadedChannels, loadedGroups] = await Promise.all([
      fetchManagedChannels(catalog, sources),
      catalog.listCustomGroups
        ? catalog.listCustomGroups(undefined, { includeHidden: true }).catch(() => [])
        : Promise.resolve([]),
    ]);
    setChannels(loadedChannels);
    setGroups(loadedGroups);
  }, [catalog, sources]);

  useEffect(() => {
    if (!visible) return;
    setTab(initialTab);
    setRenamingKey(null);
    setRenameDraft('');
    setRenameCol(0);
    setGroupPickerKey(null);
    setGroupPickerIdx(0);
    setTvZone('header');
    setHeaderCol(initialTab === 'failover' ? 2 : initialTab === 'groups' ? 1 : 0);
    setFocusedRowIdx(0);
    setFocusedActionCol(0);
    rowYRef.current = {};
    void loadAll();
  }, [initialTab, loadAll, visible]);

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        if (renamingKey !== null) setRenamingKey(null);
        else if (groupPickerKey !== null) setGroupPickerKey(null);
        else onClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [groupPickerKey, onClose, renamingKey, visible]);

  const visibleChannels = useMemo(
    () => (showHidden ? channels : channels.filter((ch) => ch.isHidden !== true)),
    [channels, showHidden],
  );
  const headerControls = useMemo(() => buildOverlayHeaderControls(tab), [tab]);

  useEffect(() => {
    setHeaderCol((c) => Math.min(c, Math.max(0, headerControls.length - 1)));
  }, [headerControls.length]);

  useEffect(() => {
    if (visibleChannels.length === 0) {
      setFocusedRowIdx(0);
      setFocusedActionCol(0);
      return;
    }
    setFocusedRowIdx((prevRow) => {
      const clampedRow = Math.min(prevRow, visibleChannels.length - 1);
      const ch = visibleChannels[clampedRow];
      const maxCol = ch ? buildChannelRowActions(ch, groups.length > 0).length - 1 : 0;
      setFocusedActionCol((prevCol) => Math.min(prevCol, Math.max(0, maxCol)));
      return clampedRow;
    });
  }, [groups.length, visibleChannels]);

  const scrollToY = useCallback(
    (y: number) => {
      scrollViewRef.current?.scrollTo({
        y: Math.max(0, y - 24),
        animated: !theme.reduceMotion,
      });
    },
    [theme.reduceMotion],
  );

  useEffect(() => {
    if (!isTv || !visible) return;
    if (tvZone === 'header') {
      scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
      return;
    }
    if (tab === 'channels') {
      const targetY = rowYRef.current[focusedRowIdx] ?? focusedRowIdx * 84;
      scrollToY(targetY);
    }
  }, [focusedRowIdx, isTv, scrollToY, tab, theme.reduceMotion, tvZone, visible]);

  const handleToggleHidden = useCallback(
    async (channel: ItemRow) => {
      if (parentalLocked) {
        onClose();
        return;
      }
      if (!catalog.setChannelOverride || busy) return;
      setBusy(true);
      try {
        const res = await catalog.setChannelOverride({
          itemKey: channel.key,
          sourceId: channel.sourceId,
          isHidden: channel.isHidden !== true,
        });
        if (res.ok) {
          await loadAll();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onClose, onMutated, parentalLocked],
  );

  const handleSaveRename = useCallback(
    async (channel: ItemRow) => {
      if (parentalLocked) {
        onClose();
        return;
      }
      if (!catalog.setChannelOverride || busy) return;
      setBusy(true);
      try {
        const res = await catalog.setChannelOverride({
          itemKey: channel.key,
          sourceId: channel.sourceId,
          customName: renameDraft.trim() || null,
        });
        if (res.ok) {
          setRenamingKey(null);
          setRenameDraft('');
          setRenameCol(0);
          await loadAll();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onClose, onMutated, parentalLocked, renameDraft],
  );

  const handleResetName = useCallback(
    async (channel: ItemRow) => {
      if (parentalLocked) {
        onClose();
        return;
      }
      if (!catalog.setChannelOverride || busy) return;
      setBusy(true);
      try {
        const res = await catalog.setChannelOverride({
          itemKey: channel.key,
          sourceId: channel.sourceId,
          customName: null,
        });
        if (res.ok) {
          if (renamingKey === channel.key) setRenamingKey(null);
          await loadAll();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onClose, onMutated, parentalLocked, renamingKey],
  );

  const handleMoveChannel = useCallback(
    async (index: number, delta: -1 | 1) => {
      if (parentalLocked) {
        onClose();
        return;
      }
      if (busy) return;
      const plan = computeSameSourceReorder({
        allChannels: channels,
        visibleChannels,
        visibleIndex: index,
        delta,
      });
      if (!plan) return;
      const current = visibleChannels[index];
      if (!current) return;
      setBusy(true);
      try {
        if (catalog.reorderChannels !== undefined && plan.updatedSourceKeys.length > 0) {
          const res = await catalog.reorderChannels(plan.updatedSourceKeys, plan.sourceId);
          if (res.ok) {
            setFocusedRowIdx(plan.nextVisibleIndex);
            await loadAll();
            onMutated?.();
          }
        } else if (catalog.setChannelOverride !== undefined) {
          const res = await catalog.setChannelOverride({
            itemKey: current.key,
            sourceId: plan.sourceId,
            sortOrder: plan.targetSortOrder,
          });
          if (res.ok) {
            setFocusedRowIdx(plan.nextVisibleIndex);
            await loadAll();
            onMutated?.();
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, channels, loadAll, onClose, onMutated, parentalLocked, visibleChannels],
  );

  const handleAddToGroup = useCallback(
    async (groupId: string, channel: ItemRow) => {
      if (parentalLocked) {
        onClose();
        return;
      }
      if (!catalog.addChannelToCustomGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.addChannelToCustomGroup(groupId, channel.key, channel.sourceId);
        if (res.ok) {
          setGroupPickerKey(null);
          setGroupPickerIdx(0);
          await loadAll();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onClose, onMutated, parentalLocked],
  );

  const handleTvBack = useCallback(() => {
    if (renamingKey !== null) {
      setRenamingKey(null);
      setRenameDraft('');
      setRenameCol(0);
      return;
    }
    if (groupPickerKey !== null) {
      setGroupPickerKey(null);
      setGroupPickerIdx(0);
      return;
    }
    if (tab === 'groups' && tvZone === 'body' && groupsTvHandlerRef.current?.('back')) {
      return;
    }
    if (tab === 'failover' && tvZone === 'body' && failoverTvHandlerRef.current?.('back')) {
      return;
    }
    onClose();
  }, [groupPickerKey, onClose, renamingKey, tab, tvZone]);

  const handleTvNavigate = useCallback(
    (key: KeyInput['key']) => {
      if (tvZone === 'header') {
        if (key === 'left') {
          setHeaderCol((c) => Math.max(0, c - 1));
          return;
        }
        if (key === 'right') {
          setHeaderCol((c) => Math.min(headerControls.length - 1, c + 1));
          return;
        }
        if (key === 'down') {
          if (tab === 'groups' || tab === 'failover' || visibleChannels.length > 0) {
            setTvZone('body');
          }
          return;
        }
        if (key === 'select') {
          const ctrl = headerControls[headerCol];
          if (ctrl === 'tab-channels') setTab('channels');
          else if (ctrl === 'tab-groups') setTab('groups');
          else if (ctrl === 'tab-failover') setTab('failover');
          else if (ctrl === 'show-hidden') setShowHidden((prev) => !prev);
          else if (ctrl === 'close') onClose();
        }
        return;
      }

      if (tab === 'groups') {
        groupsTvHandlerRef.current?.(key);
        return;
      }
      if (tab === 'failover') {
        failoverTvHandlerRef.current?.(key);
        return;
      }

      const activeChannel = visibleChannels[focusedRowIdx];
      if (!activeChannel) {
        if (key === 'up') setTvZone('header');
        return;
      }

      if (renamingKey === activeChannel.key) {
        if (key === 'left') setRenameCol((c) => (c > 0 ? ((c - 1) as 0 | 1 | 2) : 0));
        else if (key === 'right') setRenameCol((c) => (c < 2 ? ((c + 1) as 0 | 1 | 2) : 2));
        else if (key === 'select') {
          if (renameCol === 0) renameInputRef.current?.focus();
          else if (renameCol === 1) void handleSaveRename(activeChannel);
          else {
            setRenamingKey(null);
            setRenameDraft('');
            setRenameCol(0);
          }
        }
        return;
      }

      if (groupPickerKey === activeChannel.key) {
        if (key === 'left') setGroupPickerIdx((i) => Math.max(0, i - 1));
        else if (key === 'right')
          setGroupPickerIdx((i) => Math.min(Math.max(0, groups.length - 1), i + 1));
        else if (key === 'select') {
          const picked = groups[groupPickerIdx];
          if (picked) void handleAddToGroup(picked.id, activeChannel);
        }
        return;
      }

      const rowActions = buildChannelRowActions(activeChannel, groups.length > 0);
      if (key === 'up') {
        if (focusedRowIdx === 0) {
          setTvZone('header');
        } else {
          const nextRow = focusedRowIdx - 1;
          const nextCh = visibleChannels[nextRow];
          const nextMaxCol = nextCh
            ? buildChannelRowActions(nextCh, groups.length > 0).length - 1
            : 0;
          setFocusedRowIdx(nextRow);
          setFocusedActionCol((c) => Math.min(c, Math.max(0, nextMaxCol)));
        }
        return;
      }
      if (key === 'down') {
        const nextRow = Math.min(Math.max(0, visibleChannels.length - 1), focusedRowIdx + 1);
        const nextCh = visibleChannels[nextRow];
        const nextMaxCol = nextCh
          ? buildChannelRowActions(nextCh, groups.length > 0).length - 1
          : 0;
        setFocusedRowIdx(nextRow);
        setFocusedActionCol((c) => Math.min(c, Math.max(0, nextMaxCol)));
        return;
      }
      if (key === 'left') {
        setFocusedActionCol((c) => Math.max(0, c - 1));
        return;
      }
      if (key === 'right') {
        setFocusedActionCol((c) => Math.min(Math.max(0, rowActions.length - 1), c + 1));
        return;
      }
      if (key === 'select') {
        const action = rowActions[focusedActionCol];
        if (action === 'rename') {
          setGroupPickerKey(null);
          setRenamingKey(activeChannel.key);
          setRenameDraft(activeChannel.name);
          setRenameCol(0);
        } else if (action === 'resetName') {
          void handleResetName(activeChannel);
        } else if (action === 'toggleHide') {
          void handleToggleHidden(activeChannel);
        } else if (action === 'moveUp') {
          if (canMoveChannelInSource(visibleChannels, focusedRowIdx, -1)) {
            void handleMoveChannel(focusedRowIdx, -1);
          }
        } else if (action === 'moveDown') {
          if (canMoveChannelInSource(visibleChannels, focusedRowIdx, 1)) {
            void handleMoveChannel(focusedRowIdx, 1);
          }
        } else if (action === 'addToGroup') {
          setRenamingKey(null);
          setGroupPickerKey(activeChannel.key);
          setGroupPickerIdx(0);
        }
      }
    },
    [
      focusedActionCol,
      focusedRowIdx,
      groupPickerIdx,
      groupPickerKey,
      groups,
      handleAddToGroup,
      handleMoveChannel,
      handleResetName,
      handleSaveRename,
      handleToggleHidden,
      headerCol,
      headerControls,
      onClose,
      renameCol,
      renamingKey,
      tab,
      tvZone,
      visibleChannels,
    ],
  );

  if (!visible || parentalLocked) return null;

  const focusedHeaderCtrl = isTv && tvZone === 'header' ? headerControls[headerCol] : null;

  return (
    <View testID="channel-management-overlay" style={styles.root}>
      {isTv ? <OverlayTvKeyTrap onBack={handleTvBack} onNavigate={handleTvNavigate} /> : null}
      <Pressable
        testID="channel-manage-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <View style={styles.headerTitles}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('channels.manage.title')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('channels.manage.subtitle')}
            </Text>
          </View>
          <CtaButton
            testID="channel-manage-close-btn"
            label={i18n.t('sources.qr.close')}
            variant="secondary"
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'close'}
            onPress={onClose}
          />
        </View>

        <View style={styles.tabsRow}>
          <FilterChip
            testID="channel-manage-tab-channels"
            label={i18n.t('channels.manage.channelsTab')}
            selected={tab === 'channels'}
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'tab-channels'}
            onPress={() => setTab('channels')}
          />
          <FilterChip
            testID="channel-manage-tab-groups"
            label={i18n.t('channels.manage.groupsTab')}
            selected={tab === 'groups'}
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'tab-groups'}
            onPress={() => setTab('groups')}
          />
          <FilterChip
            testID="channel-manage-tab-failover"
            label={i18n.t('channels.manage.tab.failover')}
            selected={tab === 'failover'}
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'tab-failover'}
            onPress={() => setTab('failover')}
          />
          {tab === 'channels' ? (
            <FilterChip
              testID="channel-manage-show-hidden"
              label={i18n.t('channels.manage.showHidden')}
              selected={showHidden}
              focusable={!isTv}
              focused={focusedHeaderCtrl === 'show-hidden'}
              onPress={() => setShowHidden((prev) => !prev)}
            />
          ) : null}
        </View>

        <ScrollView
          ref={scrollViewRef}
          testID="channel-manage-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          {...(isTv ? { focusable: false } : {})}
        >
          {tab === 'channels' ? (
            visibleChannels.length === 0 ? (
              <Text
                testID="channel-manage-empty"
                style={[theme.typography.body, { color: theme.colors.textMuted }]}
              >
                {i18n.t('channels.manage.empty')}
              </Text>
            ) : (
              <View style={styles.channelList}>
                {visibleChannels.map((ch, idx) => {
                  const isRenaming = renamingKey === ch.key;
                  const isPickingGroup = groupPickerKey === ch.key;
                  const isRowFocused = isTv && tvZone === 'body' && focusedRowIdx === idx;
                  const rowActions = buildChannelRowActions(ch, groups.length > 0);
                  const focusedAction =
                    isRowFocused && !isRenaming && !isPickingGroup
                      ? (rowActions[focusedActionCol] ?? null)
                      : null;

                  return (
                    <ChannelManagementRow
                      key={ch.key}
                      channel={ch}
                      groups={groups}
                      isTv={isTv}
                      isRowFocused={isRowFocused}
                      focusedAction={focusedAction}
                      isRenaming={isRenaming}
                      renameDraft={renameDraft}
                      renameCol={renameCol}
                      {...(isRenaming ? { renameInputRef } : {})}
                      isPickingGroup={isPickingGroup}
                      groupPickerIdx={groupPickerIdx}
                      canMoveUp={canMoveChannelInSource(visibleChannels, idx, -1)}
                      canMoveDown={canMoveChannelInSource(visibleChannels, idx, 1)}
                      busy={busy}
                      onLayoutY={(y) => {
                        rowYRef.current[idx] = y;
                      }}
                      onStartRename={() => {
                        setGroupPickerKey(null);
                        setRenamingKey(ch.key);
                        setRenameDraft(ch.name);
                        setRenameCol(0);
                      }}
                      onChangeRenameDraft={setRenameDraft}
                      onSaveRename={() => void handleSaveRename(ch)}
                      onCancelRename={() => {
                        setRenamingKey(null);
                        setRenameDraft('');
                        setRenameCol(0);
                      }}
                      onResetName={() => void handleResetName(ch)}
                      onToggleHidden={() => void handleToggleHidden(ch)}
                      onMoveUp={() => void handleMoveChannel(idx, -1)}
                      onMoveDown={() => void handleMoveChannel(idx, 1)}
                      onToggleGroupPicker={() => {
                        setRenamingKey(null);
                        setGroupPickerKey(isPickingGroup ? null : ch.key);
                        setGroupPickerIdx(0);
                      }}
                      onPickGroup={(groupId) => void handleAddToGroup(groupId, ch)}
                    />
                  );
                })}
              </View>
            )
          ) : tab === 'groups' ? (
            <ChannelGroupsManagerTab
              catalog={catalog}
              groups={groups}
              isTv={isTv}
              tvActive={tvZone === 'body'}
              tvKeyHandlerRef={groupsTvHandlerRef}
              onEdgeTop={() => setTvZone('header')}
              onScrollToY={scrollToY}
              onRefresh={loadAll}
              {...(onMutated !== undefined ? { onMutated } : {})}
            />
          ) : (
            <FailoverGroupsTab
              catalog={catalog}
              channels={channels}
              sources={sources}
              isTv={isTv}
              tvActive={tvZone === 'body'}
              tvKeyHandlerRef={failoverTvHandlerRef}
              onEdgeTop={() => setTvZone('header')}
              onScrollToY={scrollToY}
              {...(onMutated !== undefined ? { onMutated } : {})}
            />
          )}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * Cinema Quietude v2 in-tree Channel Management, Custom Groups & Multi-Source Failover overlay (`#60`, `#157`).
 * Never uses React Native `<Modal>`; integrates `TextEntryBoundary`, 2D TV D-pad traversal,
 * and parental PIN enforcement.
 */
export function ChannelManagementOverlay(
  props: ChannelManagementOverlayProps,
): ReactElement | null {
  if (!props.visible) return null;
  return (
    <TextEntryBoundary>
      <ChannelManagementOverlayBody {...props} />
    </TextEntryBoundary>
  );
}

import type { CatalogService, CustomGroupRecord, ItemRow, SourceRow } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  FilterChip,
  MicroPill,
  Surface,
  TextEntryBoundary,
  TvFocusAnchor,
  TvTextInput,
  useI18n,
  useTextEntrySuspension,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChannelGroupsManagerTab } from './ChannelGroupsManagerTab';

const MAX_MANAGED_CHANNELS = 200;
const NOOP_TV_SUBSCRIBER = (): boolean => false;

type ManageTab = 'channels' | 'groups';

/** Props of {@link ChannelManagementOverlay}. */
export interface ChannelManagementOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly initialTab?: ManageTab;
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
        {
          includeHidden: true,
        },
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
  const isTv = viewport.formFactor === 'tv';
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  const [tab, setTab] = useState<ManageTab>(initialTab);
  const [showHidden, setShowHidden] = useState(true);
  const [channels, setChannels] = useState<readonly ItemRow[]>([]);
  const [groups, setGroups] = useState<readonly CustomGroupRecord[]>([]);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [groupPickerKey, setGroupPickerKey] = useState<string | null>(null);
  const [focusedRowIdx, setFocusedRowIdx] = useState(0);
  const [busy, setBusy] = useState(false);

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
    setGroupPickerKey(null);
    setFocusedRowIdx(0);
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

  const handleToggleHidden = useCallback(
    async (channel: ItemRow) => {
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
    [busy, catalog, loadAll, onMutated],
  );

  const handleSaveRename = useCallback(
    async (channel: ItemRow) => {
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
          await loadAll();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onMutated, renameDraft],
  );

  const handleResetName = useCallback(
    async (channel: ItemRow) => {
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
    [busy, catalog, loadAll, onMutated, renamingKey],
  );

  const handleMoveChannel = useCallback(
    async (index: number, delta: -1 | 1) => {
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= visibleChannels.length || busy) return;
      const current = visibleChannels[index];
      const neighbor = visibleChannels[targetIndex];
      if (!current || !neighbor) return;
      setBusy(true);
      try {
        const nextOrder = [...visibleChannels];
        nextOrder[index] = neighbor;
        nextOrder[targetIndex] = current;
        const sameSourceKeys = nextOrder
          .filter((ch) => ch.sourceId === current.sourceId)
          .map((ch) => ch.key);
        if (catalog.reorderChannels !== undefined && sameSourceKeys.length > 0) {
          const res = await catalog.reorderChannels(sameSourceKeys, current.sourceId);
          if (res.ok) {
            setFocusedRowIdx(targetIndex);
            await loadAll();
            onMutated?.();
          }
        } else if (catalog.setChannelOverride !== undefined) {
          const res = await catalog.setChannelOverride({
            itemKey: current.key,
            sourceId: current.sourceId,
            sortOrder: targetIndex,
          });
          if (res.ok) {
            setFocusedRowIdx(targetIndex);
            await loadAll();
            onMutated?.();
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onMutated, visibleChannels],
  );

  const handleAddToGroup = useCallback(
    async (groupId: string, channel: ItemRow) => {
      if (!catalog.addChannelToCustomGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.addChannelToCustomGroup(groupId, channel.key, channel.sourceId);
        if (res.ok) {
          setGroupPickerKey(null);
          await loadAll();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadAll, onMutated],
  );

  const handleTvBack = useCallback(() => {
    if (renamingKey !== null) setRenamingKey(null);
    else if (groupPickerKey !== null) setGroupPickerKey(null);
    else onClose();
  }, [groupPickerKey, onClose, renamingKey]);

  const handleTvNavigate = useCallback(
    (key: KeyInput['key']) => {
      if (key === 'left') {
        setTab('channels');
      } else if (key === 'right') {
        setTab('groups');
      } else if (key === 'up') {
        setFocusedRowIdx((prev) => Math.max(0, prev - 1));
      } else if (key === 'down') {
        setFocusedRowIdx((prev) => Math.min(Math.max(0, visibleChannels.length - 1), prev + 1));
      }
    },
    [visibleChannels.length],
  );

  if (!visible) return null;

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
            onPress={onClose}
          />
        </View>

        <View style={styles.tabsRow}>
          <FilterChip
            testID="channel-manage-tab-channels"
            label={i18n.t('channels.manage.channelsTab')}
            selected={tab === 'channels'}
            focusable={!isTv}
            onPress={() => setTab('channels')}
          />
          <FilterChip
            testID="channel-manage-tab-groups"
            label={i18n.t('channels.manage.groupsTab')}
            selected={tab === 'groups'}
            focusable={!isTv}
            onPress={() => setTab('groups')}
          />
          {tab === 'channels' ? (
            <FilterChip
              testID="channel-manage-show-hidden"
              label={i18n.t('channels.manage.showHidden')}
              selected={showHidden}
              focusable={!isTv}
              onPress={() => setShowHidden((prev) => !prev)}
            />
          ) : null}
        </View>

        <ScrollView
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
                  const isRowFocused = isTv && focusedRowIdx === idx;
                  const isRenamed = ch.originalName !== undefined && ch.originalName !== null;

                  return (
                    <Surface
                      key={ch.key}
                      testID={`channel-manage-row-${ch.key}`}
                      tone="surface"
                      bordered
                      rounded="card"
                      style={[
                        styles.channelCard,
                        isRowFocused
                          ? {
                              borderColor: theme.colors.focusRingColor,
                              backgroundColor: theme.colors.focusFill,
                            }
                          : null,
                      ]}
                    >
                      <View style={styles.channelRowHeader}>
                        <View style={styles.channelMeta}>
                          <Text
                            numberOfLines={1}
                            style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                          >
                            {ch.name}
                          </Text>
                          {ch.isHidden === true ? (
                            <MicroPill
                              testID={`channel-manage-hidden-badge-${ch.key}`}
                              label={i18n.t('channels.manage.hiddenBadge')}
                              tone="neutral"
                            />
                          ) : null}
                        </View>

                        <View style={styles.actionCluster}>
                          <SmallBtn
                            testID={`channel-manage-rename-${ch.key}`}
                            label={i18n.t('channels.manage.rename')}
                            onPress={() => {
                              setGroupPickerKey(null);
                              setRenamingKey(ch.key);
                              setRenameDraft(ch.name);
                            }}
                          />
                          {isRenamed ? (
                            <SmallBtn
                              testID={`channel-manage-reset-name-${ch.key}`}
                              label={i18n.t('channels.manage.resetName')}
                              onPress={() => void handleResetName(ch)}
                            />
                          ) : null}
                          <SmallBtn
                            testID={`channel-manage-toggle-hide-${ch.key}`}
                            label={i18n.t(
                              ch.isHidden === true
                                ? 'channels.manage.unhide'
                                : 'channels.manage.hide',
                            )}
                            onPress={() => void handleToggleHidden(ch)}
                          />
                          <SmallBtn
                            testID={`channel-manage-move-up-${ch.key}`}
                            label={i18n.t('channels.manage.moveUp')}
                            disabled={idx === 0 || busy}
                            onPress={() => void handleMoveChannel(idx, -1)}
                          />
                          <SmallBtn
                            testID={`channel-manage-move-down-${ch.key}`}
                            label={i18n.t('channels.manage.moveDown')}
                            disabled={idx >= visibleChannels.length - 1 || busy}
                            onPress={() => void handleMoveChannel(idx, 1)}
                          />
                          {groups.length > 0 ? (
                            <SmallBtn
                              testID={`channel-manage-add-to-group-${ch.key}`}
                              label={i18n.t('channels.manage.addToGroup')}
                              onPress={() => {
                                setRenamingKey(null);
                                setGroupPickerKey(isPickingGroup ? null : ch.key);
                              }}
                            />
                          ) : null}
                        </View>
                      </View>

                      {isRenaming ? (
                        <View style={styles.inlineEditor}>
                          <TvTextInput
                            testID={`channel-manage-rename-input-${ch.key}`}
                            value={renameDraft}
                            onChangeText={setRenameDraft}
                            placeholder={i18n.t('channels.manage.renamePlaceholder')}
                            placeholderTextColor={theme.colors.textMuted}
                            onSubmitEditing={() => void handleSaveRename(ch)}
                            style={[
                              styles.input,
                              theme.typography.body,
                              {
                                color: theme.colors.textPrimary,
                                backgroundColor: theme.colors.bgCard,
                                borderColor: theme.colors.accent,
                                borderRadius: theme.radius.button,
                              },
                            ]}
                          />
                          <CtaButton
                            testID={`channel-manage-rename-save-${ch.key}`}
                            label={i18n.t('channels.manage.save')}
                            variant="primary"
                            disabled={busy}
                            focusable={!isTv}
                            onPress={() => void handleSaveRename(ch)}
                          />
                          <CtaButton
                            testID={`channel-manage-rename-cancel-${ch.key}`}
                            label={i18n.t('channels.manage.cancel')}
                            variant="secondary"
                            focusable={!isTv}
                            onPress={() => {
                              setRenamingKey(null);
                              setRenameDraft('');
                            }}
                          />
                        </View>
                      ) : null}

                      {isPickingGroup ? (
                        <View
                          testID={`channel-manage-group-picker-${ch.key}`}
                          style={styles.groupPickerRow}
                        >
                          {groups.map((g) => (
                            <Pressable
                              key={g.id}
                              testID={`channel-manage-pick-group-${ch.key}-${g.id}`}
                              accessibilityRole="button"
                              accessibilityLabel={g.name}
                              onPress={() => void handleAddToGroup(g.id, ch)}
                              style={[
                                styles.groupPickChip,
                                cursor,
                                transition,
                                {
                                  backgroundColor: theme.colors.bgCard,
                                  borderColor: theme.colors.accent,
                                  borderRadius: theme.radius.button,
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  theme.typography.caption,
                                  { color: theme.colors.textPrimary },
                                ]}
                              >
                                {g.name}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                    </Surface>
                  );
                })}
              </View>
            )
          ) : (
            <ChannelGroupsManagerTab
              catalog={catalog}
              groups={groups}
              isTv={isTv}
              onRefresh={loadAll}
              {...(onMutated !== undefined ? { onMutated } : {})}
            />
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function SmallBtn({
  testID,
  label,
  disabled = false,
  onPress,
}: {
  readonly testID: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallBtn,
        cursor,
        transition,
        {
          borderRadius: theme.radius.button,
          backgroundColor: pressed ? theme.colors.subtleHighlight : theme.colors.bgCard,
          borderColor: theme.colors.surfaceBorder,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Cinema Quietude v2 in-tree Channel Management & Custom Groups overlay (`#60`).
 * Never uses React Native `<Modal>`; integrates `TextEntryBoundary` + exclusive `useTvKeyInterceptor`.
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

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 55,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 820,
    maxHeight: '88%',
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitles: { flex: 1, gap: 2 },
  tabsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollContent: { paddingBottom: 8 },
  channelList: { gap: 10 },
  channelCard: { padding: 12, gap: 10 },
  channelRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
  },
  channelMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 160 },
  actionCluster: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  smallBtn: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineEditor: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: {
    flex: 1,
    minWidth: 180,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  groupPickerRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  groupPickChip: {
    minHeight: 32,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

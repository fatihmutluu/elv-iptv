import type {
  CatalogService,
  FailoverGroupRecord,
  ItemRow,
  SourceRow,
  SuggestedFailoverCluster,
} from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  MicroPill,
  Surface,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import {
  type MutableRefObject,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { FailoverGroupCard } from './FailoverGroupCard';
import {
  buildFailoverTabFocusRows,
  getAvailableFailoverChannels,
  reorderFailoverMemberKeys,
} from './failover-groups-model';
import { SourceBadgePill } from './SourceBadgePill';
import { buildSourceBadgeMap, type SourceBadgeInfo } from './source-badge';

const MAX_PICKER_CANDIDATES = 40;

/** Props of {@link FailoverGroupsTab}. */
export interface FailoverGroupsTabProps {
  readonly catalog: CatalogService;
  readonly channels: readonly ItemRow[];
  readonly sources: readonly SourceRow[];
  readonly isTv: boolean;
  /** Whether 10-ft TV D-pad focus is currently inside this tab's body. */
  readonly tvActive?: boolean;
  /** Imperative ref populated with this tab's TV key handler (`true` = handled). */
  readonly tvKeyHandlerRef?: MutableRefObject<((key: KeyInput['key']) => boolean) | null>;
  /** Invoked when pressing Up from row 0 so parent restores focus to the overlay header tabs. */
  readonly onEdgeTop?: () => void;
  /** Requests parent `ScrollView` to scroll to the focused row's Y offset. */
  readonly onScrollToY?: (y: number) => void;
  readonly onMutated?: () => void;
}

/**
 * Multi-Source Failover Groups management tab inside {@link ChannelManagementOverlay} (`#157`).
 * Supports cross-source auto-match clustering, manual group creation/deletion, channel member
 * management, priority reordering (`#1 Primary`, `#2`, `#3`), and full 2D 10-ft TV D-pad navigation.
 */
export function FailoverGroupsTab({
  catalog,
  channels,
  sources,
  isTv,
  tvActive = false,
  tvKeyHandlerRef,
  onEdgeTop,
  onScrollToY,
  onMutated,
}: FailoverGroupsTabProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const profile = useProfile();
  const parentalLocked = profile.hasGuardPin && !profile.parentalUnlocked;

  const [groups, setGroups] = useState<readonly FailoverGroupRecord[]>([]);
  const [suggestions, setSuggestions] = useState<readonly SuggestedFailoverCluster[]>([]);
  const [noSuggestionsNotice, setNoSuggestionsNotice] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [pickingGroupId, setPickingGroupId] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const [focusedRow, setFocusedRow] = useState(0);
  const [focusedCol, setFocusedCol] = useState(0);
  const newGroupInputRef = useRef<TvTextInputInstance | null>(null);
  const renameGroupInputRef = useRef<TvTextInputInstance | null>(null);
  const groupCardYRef = useRef<Record<string, number>>({});
  const groupListYRef = useRef(0);

  const sourceBadges = useMemo(() => buildSourceBadgeMap(sources, theme, true), [sources, theme]);
  const resolveBadge = useCallback(
    (sourceId: string, fallbackName?: string): SourceBadgeInfo | null => {
      const hit = sourceBadges.get(sourceId);
      if (hit !== undefined) return hit;
      const src = sources.find((s) => s.id === sourceId);
      const label = (src?.name ?? fallbackName ?? '').trim();
      if (label.length === 0) return null;
      return { sourceId, label: label.slice(0, 10), color: theme.colors.textSecondary };
    },
    [sourceBadges, sources, theme.colors.textSecondary],
  );

  const channelsByKey = useMemo(() => {
    const map = new Map<string, ItemRow>();
    for (const ch of channels) map.set(ch.key, ch);
    return map;
  }, [channels]);

  const availableChannelsByGroupId = useMemo(() => {
    const record: Record<string, readonly ItemRow[]> = {};
    for (const group of groups) {
      record[group.id] = getAvailableFailoverChannels(channels, group).slice(
        0,
        MAX_PICKER_CANDIDATES,
      );
    }
    return record;
  }, [channels, groups]);

  const loadGroups = useCallback(async () => {
    if (!catalog.listFailoverGroups) {
      setGroups([]);
      return;
    }
    const loaded = await catalog.listFailoverGroups().catch(() => [] as FailoverGroupRecord[]);
    setGroups(loaded);
  }, [catalog]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const focusRows = useMemo(
    () =>
      buildFailoverTabFocusRows({
        groups,
        hasSuggestions: suggestions.length > 0,
        pickingGroupId,
        renamingGroupId,
        availableChannelsByGroupId,
      }),
    [availableChannelsByGroupId, groups, pickingGroupId, renamingGroupId, suggestions.length],
  );

  useEffect(() => {
    const maxRow = Math.max(0, focusRows.length - 1);
    const clampedRow = Math.min(focusedRow, maxRow);
    const maxCol = Math.max(0, (focusRows[clampedRow]?.cols.length ?? 1) - 1);
    if (clampedRow !== focusedRow) {
      setFocusedRow(clampedRow);
    }
    if (focusedCol > maxCol) {
      setFocusedCol(maxCol);
    }
  }, [focusRows, focusedCol, focusedRow]);

  useEffect(() => {
    if (!isTv || !tvActive || onScrollToY === undefined) return;
    const row = focusRows[focusedRow];
    if (!row || row.kind === 'auto-match' || row.kind === 'create') {
      onScrollToY(0);
      return;
    }
    const cardY = groupCardYRef.current[row.groupId];
    const targetY = cardY !== undefined ? groupListYRef.current + cardY : focusedRow * 72;
    onScrollToY(targetY);
  }, [focusRows, focusedRow, isTv, onScrollToY, tvActive]);

  const handleAutoMatch = useCallback(async () => {
    if (parentalLocked || !catalog.suggestFailoverGroups || busy) return;
    setBusy(true);
    try {
      const found = await catalog
        .suggestFailoverGroups()
        .catch(() => [] as SuggestedFailoverCluster[]);
      setSuggestions(found);
      setNoSuggestionsNotice(found.length === 0);
    } finally {
      setBusy(false);
    }
  }, [busy, catalog, parentalLocked]);

  const handleApplySuggestions = useCallback(async () => {
    if (
      parentalLocked ||
      suggestions.length === 0 ||
      !catalog.applySuggestedFailoverGroups ||
      busy
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await catalog.applySuggestedFailoverGroups(suggestions);
      if (res.ok) {
        setSuggestions([]);
        setNoSuggestionsNotice(false);
        await loadGroups();
        onMutated?.();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, catalog, loadGroups, onMutated, parentalLocked, suggestions]);

  const handleCreateGroup = useCallback(async () => {
    const trimmed = newGroupName.trim();
    if (parentalLocked || trimmed.length === 0 || !catalog.createFailoverGroup || busy) return;
    setBusy(true);
    try {
      const res = await catalog.createFailoverGroup({ name: trimmed });
      if (res.ok) {
        setNewGroupName('');
        await loadGroups();
        onMutated?.();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, catalog, loadGroups, newGroupName, onMutated, parentalLocked]);

  const handleStartRename = useCallback((group: FailoverGroupRecord) => {
    setPickingGroupId(null);
    setRenamingGroupId(group.id);
    setRenameDraft(group.name);
    setFocusedCol(0);
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingGroupId(null);
    setRenameDraft('');
  }, []);

  const handleSaveRename = useCallback(
    async (groupId: string) => {
      const trimmed = renameDraft.trim();
      if (parentalLocked || trimmed.length === 0 || !catalog.renameFailoverGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.renameFailoverGroup(groupId, trimmed);
        if (res.ok) {
          setRenamingGroupId(null);
          setRenameDraft('');
          await loadGroups();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadGroups, onMutated, parentalLocked, renameDraft],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (parentalLocked || !catalog.deleteFailoverGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.deleteFailoverGroup(groupId);
        if (res.ok) {
          if (pickingGroupId === groupId) setPickingGroupId(null);
          if (renamingGroupId === groupId) {
            setRenamingGroupId(null);
            setRenameDraft('');
          }
          await loadGroups();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadGroups, onMutated, parentalLocked, pickingGroupId, renamingGroupId],
  );

  const handleAddMember = useCallback(
    async (groupId: string, channelKey: string) => {
      if (parentalLocked || !catalog.addFailoverGroupMember || busy) return;
      setBusy(true);
      try {
        const res = await catalog.addFailoverGroupMember(groupId, channelKey);
        if (res.ok) {
          setPickingGroupId(null);
          await loadGroups();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadGroups, onMutated, parentalLocked],
  );

  const handleRemoveMember = useCallback(
    async (groupId: string, channelKey: string) => {
      if (parentalLocked || !catalog.removeFailoverGroupMember || busy) return;
      setBusy(true);
      try {
        const res = await catalog.removeFailoverGroupMember(groupId, channelKey);
        if (res.ok) {
          await loadGroups();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadGroups, onMutated, parentalLocked],
  );

  const handleMoveMember = useCallback(
    async (groupId: string, index: number, delta: -1 | 1) => {
      if (parentalLocked || !catalog.reorderFailoverGroupMembers || busy) return;
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      const ordered = reorderFailoverMemberKeys(group.members, index, delta);
      if (!ordered) return;
      setBusy(true);
      try {
        const res = await catalog.reorderFailoverGroupMembers(groupId, ordered);
        if (res.ok) {
          await loadGroups();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, groups, loadGroups, onMutated, parentalLocked],
  );

  const stateRef = useRef({
    groups,
    focusRows,
    focusedRow,
    focusedCol,
    pickingGroupId,
    renamingGroupId,
    onEdgeTop,
    handleAutoMatch,
    handleApplySuggestions,
    handleCreateGroup,
    handleStartRename,
    handleCancelRename,
    handleSaveRename,
    handleDeleteGroup,
    handleAddMember,
    handleRemoveMember,
    handleMoveMember,
  });
  stateRef.current = {
    groups,
    focusRows,
    focusedRow,
    focusedCol,
    pickingGroupId,
    renamingGroupId,
    onEdgeTop,
    handleAutoMatch,
    handleApplySuggestions,
    handleCreateGroup,
    handleStartRename,
    handleCancelRename,
    handleSaveRename,
    handleDeleteGroup,
    handleAddMember,
    handleRemoveMember,
    handleMoveMember,
  };

  useEffect(() => {
    if (!tvKeyHandlerRef) return undefined;
    tvKeyHandlerRef.current = (key: KeyInput['key']): boolean => {
      const s = stateRef.current;
      if (key === 'back') {
        if (s.renamingGroupId !== null) {
          s.handleCancelRename();
          return true;
        }
        if (s.pickingGroupId !== null) {
          setPickingGroupId(null);
          return true;
        }
        return false;
      }

      const curRow = s.focusRows[s.focusedRow];
      if (!curRow) return false;

      if (key === 'left') {
        setFocusedCol((c) => Math.max(0, c - 1));
        return true;
      }
      if (key === 'right') {
        setFocusedCol((c) => Math.min(curRow.cols.length - 1, c + 1));
        return true;
      }
      if (key === 'up') {
        if (s.renamingGroupId !== null) return true;
        if (s.focusedRow === 0) {
          s.onEdgeTop?.();
          return true;
        }
        const nextRow = s.focusedRow - 1;
        const nextMaxCol = Math.max(0, (s.focusRows[nextRow]?.cols.length ?? 1) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, nextMaxCol));
        return true;
      }
      if (key === 'down') {
        if (s.renamingGroupId !== null) return true;
        const nextRow = Math.min(s.focusRows.length - 1, s.focusedRow + 1);
        const nextMaxCol = Math.max(0, (s.focusRows[nextRow]?.cols.length ?? 1) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, nextMaxCol));
        return true;
      }
      if (key === 'select') {
        if (curRow.kind === 'auto-match') {
          if (s.focusedCol === 0) void s.handleAutoMatch();
          else void s.handleApplySuggestions();
          return true;
        }
        if (curRow.kind === 'create') {
          if (s.focusedCol === 0) newGroupInputRef.current?.focus();
          else void s.handleCreateGroup();
          return true;
        }
        if (curRow.kind === 'group-edit') {
          if (s.focusedCol === 0) renameGroupInputRef.current?.focus();
          else if (s.focusedCol === 1) void s.handleSaveRename(curRow.groupId);
          else s.handleCancelRename();
          return true;
        }
        if (curRow.kind === 'group-header') {
          if (s.focusedCol === 0) {
            setRenamingGroupId(null);
            setPickingGroupId(s.pickingGroupId === curRow.groupId ? null : curRow.groupId);
          } else if (s.focusedCol === 1) {
            const target = s.groups.find((g) => g.id === curRow.groupId);
            if (target) s.handleStartRename(target);
          } else {
            void s.handleDeleteGroup(curRow.groupId);
          }
          return true;
        }
        if (curRow.kind === 'picker-channel') {
          void s.handleAddMember(curRow.groupId, curRow.channelKey);
          return true;
        }
        if (curRow.kind === 'member') {
          if (s.focusedCol === 0) void s.handleMoveMember(curRow.groupId, curRow.index, -1);
          else if (s.focusedCol === 1) void s.handleMoveMember(curRow.groupId, curRow.index, 1);
          else void s.handleRemoveMember(curRow.groupId, curRow.channelKey);
          return true;
        }
      }
      return false;
    };
    return () => {
      tvKeyHandlerRef.current = null;
    };
  }, [tvKeyHandlerRef]);

  const activeFocusRow = isTv && tvActive ? (focusRows[focusedRow] ?? null) : null;
  const autoMatchFocused = activeFocusRow?.kind === 'auto-match' && focusedCol === 0;
  const applySuggestionsFocused = activeFocusRow?.kind === 'auto-match' && focusedCol === 1;
  const createInputFocused = activeFocusRow?.kind === 'create' && focusedCol === 0;
  const createBtnFocused = activeFocusRow?.kind === 'create' && focusedCol === 1;

  return (
    <View testID="failover-groups-tab-content" style={styles.root}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {i18n.t('channels.failover.subtitle')}
      </Text>

      <View style={styles.actionBar}>
        <CtaButton
          testID="failover-auto-match-btn"
          label={i18n.t('channels.failover.autoMatch')}
          variant="secondary"
          disabled={busy || !catalog.suggestFailoverGroups}
          focusable={!isTv}
          focused={autoMatchFocused}
          onPress={() => void handleAutoMatch()}
        />
        {suggestions.length > 0 ? (
          <CtaButton
            testID="failover-apply-suggestions-btn"
            label={i18n.t('channels.failover.applySuggestions', { count: suggestions.length })}
            variant="primary"
            disabled={busy || !catalog.applySuggestedFailoverGroups}
            focusable={!isTv}
            focused={applySuggestionsFocused}
            onPress={() => void handleApplySuggestions()}
          />
        ) : null}
      </View>

      {noSuggestionsNotice ? (
        <Text
          testID="failover-no-suggestions"
          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
        >
          {i18n.t('channels.failover.noSuggestions')}
        </Text>
      ) : null}

      {suggestions.length > 0 ? (
        <Surface
          testID="failover-suggestions-panel"
          tone="surface"
          bordered
          rounded="card"
          style={styles.suggestionsPanel}
        >
          {suggestions.map((cluster) => (
            <View
              key={cluster.normalizedKey}
              testID={`failover-suggestion-${cluster.normalizedKey}`}
              style={styles.suggestionRow}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
              >
                {cluster.suggestedName}
              </Text>
              <MicroPill
                label={i18n.t('channels.failover.memberCount', { count: cluster.members.length })}
                tone="accent"
              />
              <View style={styles.badgeWrap}>
                {cluster.members.map((m) => (
                  <SourceBadgePill
                    key={m.channelKey}
                    badge={resolveBadge(m.sourceId, m.sourceName)}
                  />
                ))}
              </View>
            </View>
          ))}
        </Surface>
      ) : null}

      <View style={styles.createRow}>
        <TvTextInput
          ref={newGroupInputRef}
          testID="failover-new-group-input"
          value={newGroupName}
          onChangeText={setNewGroupName}
          placeholder={i18n.t('channels.failover.createPlaceholder')}
          placeholderTextColor={theme.colors.textMuted}
          onSubmitEditing={() => void handleCreateGroup()}
          style={[
            styles.input,
            theme.typography.body,
            {
              color: theme.colors.textPrimary,
              backgroundColor: createInputFocused ? theme.colors.focusFill : theme.colors.bgCard,
              borderWidth: createInputFocused ? theme.focus.ringWidth : 1,
              borderColor: createInputFocused
                ? theme.colors.focusRingColor
                : theme.colors.surfaceBorder,
              borderRadius: theme.radius.button,
            },
          ]}
        />
        <CtaButton
          testID="failover-create-group-btn"
          label={i18n.t('channels.failover.create')}
          variant="primary"
          disabled={busy || newGroupName.trim().length === 0 || !catalog.createFailoverGroup}
          focusable={!isTv}
          focused={createBtnFocused}
          onPress={() => void handleCreateGroup()}
        />
      </View>

      {groups.length === 0 ? (
        <Text
          testID="failover-groups-empty"
          style={[theme.typography.body, { color: theme.colors.textMuted }]}
        >
          {i18n.t('channels.failover.empty')}
        </Text>
      ) : (
        <View
          style={styles.groupList}
          onLayout={(e) => {
            groupListYRef.current = e.nativeEvent.layout.y;
          }}
        >
          {groups.map((group) => {
            const isRenaming = renamingGroupId === group.id;
            return (
              <FailoverGroupCard
                key={group.id}
                group={group}
                channelsByKey={channelsByKey}
                availableChannels={availableChannelsByGroupId[group.id] ?? []}
                resolveBadge={resolveBadge}
                isPickingChannel={pickingGroupId === group.id}
                isRenaming={isRenaming}
                renameDraft={isRenaming ? renameDraft : ''}
                {...(isRenaming ? { renameInputRef: renameGroupInputRef } : {})}
                canRename={catalog.renameFailoverGroup !== undefined}
                isTv={isTv}
                activeFocusRow={activeFocusRow}
                focusedCol={focusedCol}
                busy={busy}
                onLayoutY={(y) => {
                  groupCardYRef.current[group.id] = y;
                }}
                onTogglePicker={() => {
                  setRenamingGroupId(null);
                  setPickingGroupId(pickingGroupId === group.id ? null : group.id);
                }}
                onStartRename={() => handleStartRename(group)}
                onChangeRenameDraft={setRenameDraft}
                onSaveRename={() => void handleSaveRename(group.id)}
                onCancelRename={handleCancelRename}
                onDeleteGroup={() => void handleDeleteGroup(group.id)}
                onPickChannel={(chKey) => void handleAddMember(group.id, chKey)}
                onMoveMember={(idx, delta) => void handleMoveMember(group.id, idx, delta)}
                onRemoveMember={(chKey) => void handleRemoveMember(group.id, chKey)}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  actionBar: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  suggestionsPanel: { padding: 12, gap: 8 },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  badgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  createRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: {
    flex: 1,
    minWidth: 180,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  groupList: { gap: 10 },
  flex1: { flex: 1 },
});

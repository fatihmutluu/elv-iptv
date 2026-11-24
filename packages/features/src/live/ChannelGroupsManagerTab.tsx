import {
  type CatalogService,
  type CustomGroupRecord,
  customGroupCategoryId,
  type ItemRow,
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
  webCursorPointer,
  webTransition,
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
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { buildGroupTabFocusRows } from './channel-management-model';

/** Props of {@link ChannelGroupsManagerTab}. */
export interface ChannelGroupsManagerTabProps {
  readonly catalog: CatalogService;
  readonly groups: readonly CustomGroupRecord[];
  readonly isTv: boolean;
  /** Whether 10-ft TV D-pad focus is currently inside this tab's body. */
  readonly tvActive?: boolean;
  /** Imperative ref populated with this tab's TV key handler (`true` = handled). */
  readonly tvKeyHandlerRef?: MutableRefObject<((key: KeyInput['key']) => boolean) | null>;
  /** Invoked when pressing Up from row 0 so parent restores focus to the overlay header tabs. */
  readonly onEdgeTop?: () => void;
  /** Requests parent `ScrollView` to scroll to the focused row's Y offset. */
  readonly onScrollToY?: (y: number) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onMutated?: () => void;
}

/**
 * Custom groups management tab inside {@link ChannelManagementOverlay} (`#60`).
 * Supports creating, renaming, deleting custom groups, viewing/removing member channels,
 * and full 2D 10-ft TV D-pad navigation with Cinema Quietude focus rings.
 */
export function ChannelGroupsManagerTab({
  catalog,
  groups,
  isTv,
  tvActive = false,
  tvKeyHandlerRef,
  onEdgeTop,
  onScrollToY,
  onRefresh,
  onMutated,
}: ChannelGroupsManagerTabProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const profile = useProfile();
  const parentalLocked = profile.hasGuardPin && !profile.parentalUnlocked;
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [membersByGroupId, setMembersByGroupId] = useState<Record<string, readonly ItemRow[]>>({});
  const [busy, setBusy] = useState(false);

  const [focusedRow, setFocusedRow] = useState(0);
  const [focusedCol, setFocusedCol] = useState(0);
  const newGroupInputRef = useRef<TvTextInputInstance | null>(null);
  const editGroupInputRef = useRef<TvTextInputInstance | null>(null);
  const groupCardYRef = useRef<Record<string, number>>({});
  const groupListYRef = useRef(0);

  const focusRows = useMemo(
    () => buildGroupTabFocusRows(groups, editingGroupId, expandedGroupId, membersByGroupId),
    [editingGroupId, expandedGroupId, groups, membersByGroupId],
  );

  useEffect(() => {
    setFocusedRow((prevRow) => {
      const clampedRow = Math.min(prevRow, Math.max(0, focusRows.length - 1));
      const maxCol = Math.max(0, (focusRows[clampedRow]?.cols.length ?? 1) - 1);
      setFocusedCol((prevCol) => Math.min(prevCol, maxCol));
      return clampedRow;
    });
  }, [focusRows]);

  const loadGroupMembers = useCallback(
    async (groupId: string) => {
      const items = await catalog
        .items(customGroupCategoryId(groupId), 0, 200, { includeHidden: true })
        .catch(() => [] as ItemRow[]);
      setMembersByGroupId((prev) => ({ ...prev, [groupId]: items }));
    },
    [catalog],
  );

  useEffect(() => {
    if (expandedGroupId !== null) {
      void loadGroupMembers(expandedGroupId);
    }
  }, [expandedGroupId, loadGroupMembers]);

  useEffect(() => {
    if (!isTv || !tvActive || onScrollToY === undefined) return;
    const row = focusRows[focusedRow];
    if (!row || row.kind === 'create') {
      onScrollToY(0);
      return;
    }
    const cardY = groupCardYRef.current[row.groupId];
    const targetY = cardY !== undefined ? groupListYRef.current + cardY : focusedRow * 72;
    onScrollToY(targetY);
  }, [focusRows, focusedRow, isTv, onScrollToY, tvActive]);

  const handleCreateGroup = useCallback(async () => {
    const trimmed = newGroupName.trim();
    if (parentalLocked || trimmed.length === 0 || !catalog.createCustomGroup || busy) return;
    setBusy(true);
    try {
      const res = await catalog.createCustomGroup({ name: trimmed });
      if (res.ok) {
        setNewGroupName('');
        await onRefresh();
        onMutated?.();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, catalog, newGroupName, onMutated, onRefresh, parentalLocked]);

  const handleSaveRename = useCallback(
    async (groupId: string) => {
      const trimmed = editingGroupName.trim();
      if (parentalLocked || trimmed.length === 0 || !catalog.updateCustomGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.updateCustomGroup(groupId, { name: trimmed });
        if (res.ok) {
          setEditingGroupId(null);
          setEditingGroupName('');
          await onRefresh();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, editingGroupName, onMutated, onRefresh, parentalLocked],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (parentalLocked || !catalog.deleteCustomGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.deleteCustomGroup(groupId);
        if (res.ok) {
          if (expandedGroupId === groupId) setExpandedGroupId(null);
          if (editingGroupId === groupId) setEditingGroupId(null);
          await onRefresh();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, editingGroupId, expandedGroupId, onMutated, onRefresh, parentalLocked],
  );

  const handleRemoveMember = useCallback(
    async (groupId: string, itemKey: string) => {
      if (parentalLocked || !catalog.removeChannelFromCustomGroup || busy) return;
      setBusy(true);
      try {
        const res = await catalog.removeChannelFromCustomGroup(groupId, itemKey);
        if (res.ok) {
          await loadGroupMembers(groupId);
          await onRefresh();
          onMutated?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, catalog, loadGroupMembers, onMutated, onRefresh, parentalLocked],
  );

  const stateRef = useRef({
    focusRows,
    focusedRow,
    focusedCol,
    editingGroupId,
    expandedGroupId,
    groups,
    onEdgeTop,
    handleCreateGroup,
    handleSaveRename,
    handleDeleteGroup,
    handleRemoveMember,
  });
  stateRef.current = {
    focusRows,
    focusedRow,
    focusedCol,
    editingGroupId,
    expandedGroupId,
    groups,
    onEdgeTop,
    handleCreateGroup,
    handleSaveRename,
    handleDeleteGroup,
    handleRemoveMember,
  };

  useEffect(() => {
    if (!tvKeyHandlerRef) return undefined;
    tvKeyHandlerRef.current = (key: KeyInput['key']): boolean => {
      const s = stateRef.current;
      if (key === 'back') {
        if (s.editingGroupId !== null) {
          setEditingGroupId(null);
          setEditingGroupName('');
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
        if (s.editingGroupId !== null) return true;
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
        if (s.editingGroupId !== null) return true;
        const nextRow = Math.min(s.focusRows.length - 1, s.focusedRow + 1);
        const nextMaxCol = Math.max(0, (s.focusRows[nextRow]?.cols.length ?? 1) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, nextMaxCol));
        return true;
      }
      if (key === 'select') {
        if (curRow.kind === 'create') {
          if (s.focusedCol === 0) newGroupInputRef.current?.focus();
          else void s.handleCreateGroup();
          return true;
        }
        if (curRow.kind === 'group-edit') {
          if (s.focusedCol === 0) editGroupInputRef.current?.focus();
          else if (s.focusedCol === 1) void s.handleSaveRename(curRow.groupId);
          else {
            setEditingGroupId(null);
            setEditingGroupName('');
          }
          return true;
        }
        if (curRow.kind === 'group-header') {
          const targetGroup = s.groups.find((g) => g.id === curRow.groupId);
          if (s.focusedCol === 0) {
            setExpandedGroupId(s.expandedGroupId === curRow.groupId ? null : curRow.groupId);
          } else if (s.focusedCol === 1 && targetGroup) {
            setEditingGroupId(targetGroup.id);
            setEditingGroupName(targetGroup.name);
            setFocusedCol(0);
          } else if (s.focusedCol === 2) {
            void s.handleDeleteGroup(curRow.groupId);
          }
          return true;
        }
        if (curRow.kind === 'member') {
          void s.handleRemoveMember(curRow.groupId, curRow.itemKey);
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
  const createInputFocused = activeFocusRow?.kind === 'create' && focusedCol === 0;
  const createAddFocused = activeFocusRow?.kind === 'create' && focusedCol === 1;

  return (
    <View testID="channel-manage-groups-tab-content" style={styles.root}>
      <View style={styles.createRow}>
        <TvTextInput
          ref={newGroupInputRef}
          testID="channel-manage-new-group-input"
          value={newGroupName}
          onChangeText={setNewGroupName}
          placeholder={i18n.t('channels.manage.groupNamePlaceholder')}
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
          testID="channel-manage-add-group-btn"
          label={i18n.t('channels.manage.addGroup')}
          variant="primary"
          disabled={busy || newGroupName.trim().length === 0}
          focusable={!isTv}
          focused={createAddFocused}
          onPress={() => void handleCreateGroup()}
        />
      </View>

      {groups.length === 0 ? (
        <Text
          testID="channel-manage-groups-empty"
          style={[theme.typography.body, { color: theme.colors.textMuted }]}
        >
          {i18n.t('channels.manage.groupEmpty')}
        </Text>
      ) : (
        <View
          style={styles.groupList}
          onLayout={(e) => {
            groupListYRef.current = e.nativeEvent.layout.y;
          }}
        >
          {groups.map((group) => {
            const isEditing = editingGroupId === group.id;
            const isExpanded = expandedGroupId === group.id;
            const members = membersByGroupId[group.id] ?? [];

            const isGroupEditRow =
              activeFocusRow?.kind === 'group-edit' && activeFocusRow.groupId === group.id;
            const isGroupHeaderRow =
              activeFocusRow?.kind === 'group-header' && activeFocusRow.groupId === group.id;
            const isGroupFocused = isGroupEditRow || isGroupHeaderRow;

            const editInputFocused = isGroupEditRow && focusedCol === 0;
            const editSaveFocused = isGroupEditRow && focusedCol === 1;
            const editCancelFocused = isGroupEditRow && focusedCol === 2;
            const expandFocused = isGroupHeaderRow && focusedCol === 0;
            const editBtnFocused = isGroupHeaderRow && focusedCol === 1;
            const deleteBtnFocused = isGroupHeaderRow && focusedCol === 2;

            return (
              <Surface
                key={group.id}
                testID={`channel-manage-group-row-${group.id}`}
                tone="surface"
                bordered
                rounded="card"
                onLayout={(e) => {
                  groupCardYRef.current[group.id] = e.nativeEvent.layout.y;
                }}
                style={[
                  styles.groupCard,
                  isGroupFocused
                    ? {
                        borderColor: theme.colors.focusRingColor,
                        backgroundColor: theme.colors.focusFill,
                      }
                    : null,
                ]}
              >
                {isEditing ? (
                  <View style={styles.createRow}>
                    <TvTextInput
                      ref={editGroupInputRef}
                      testID={`channel-manage-edit-group-input-${group.id}`}
                      value={editingGroupName}
                      onChangeText={setEditingGroupName}
                      placeholder={i18n.t('channels.manage.groupNamePlaceholder')}
                      placeholderTextColor={theme.colors.textMuted}
                      onSubmitEditing={() => void handleSaveRename(group.id)}
                      style={[
                        styles.input,
                        theme.typography.body,
                        {
                          color: theme.colors.textPrimary,
                          backgroundColor: editInputFocused
                            ? theme.colors.focusFill
                            : theme.colors.bgCard,
                          borderWidth: editInputFocused ? theme.focus.ringWidth : 1,
                          borderColor: editInputFocused
                            ? theme.colors.focusRingColor
                            : theme.colors.accent,
                          borderRadius: theme.radius.button,
                        },
                      ]}
                    />
                    <CtaButton
                      testID={`channel-manage-save-group-${group.id}`}
                      label={i18n.t('channels.manage.save')}
                      variant="primary"
                      disabled={busy || editingGroupName.trim().length === 0}
                      focusable={!isTv}
                      focused={editSaveFocused}
                      onPress={() => void handleSaveRename(group.id)}
                    />
                    <CtaButton
                      testID={`channel-manage-cancel-group-${group.id}`}
                      label={i18n.t('channels.manage.cancel')}
                      variant="secondary"
                      focusable={!isTv}
                      focused={editCancelFocused}
                      onPress={() => {
                        setEditingGroupId(null);
                        setEditingGroupName('');
                      }}
                    />
                  </View>
                ) : (
                  <View style={styles.groupHeaderRow}>
                    <Pressable
                      testID={`channel-manage-expand-group-${group.id}`}
                      focusable={!isTv}
                      accessibilityRole="button"
                      accessibilityLabel={group.name}
                      onPress={() => setExpandedGroupId(isExpanded ? null : group.id)}
                      style={[
                        styles.groupTitleArea,
                        cursor,
                        expandFocused
                          ? {
                              borderWidth: theme.focus.ringWidth,
                              borderColor: theme.colors.focusRingColor,
                              backgroundColor: theme.colors.focusFill,
                              borderRadius: theme.radius.button,
                              paddingHorizontal: 8,
                              paddingVertical: 4,
                            }
                          : null,
                      ]}
                    >
                      <Text
                        numberOfLines={1}
                        style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                      >
                        {group.name}
                      </Text>
                      <MicroPill label={String(group.itemCount)} tone="neutral" />
                    </Pressable>
                    <View style={styles.rowActions}>
                      <Pressable
                        testID={`channel-manage-edit-group-${group.id}`}
                        focusable={!isTv}
                        accessibilityRole="button"
                        accessibilityLabel={i18n.t('channels.manage.editGroup')}
                        onPress={() => {
                          setEditingGroupId(group.id);
                          setEditingGroupName(group.name);
                        }}
                        style={[
                          styles.btn,
                          cursor,
                          transition,
                          {
                            backgroundColor: editBtnFocused
                              ? theme.colors.focusFill
                              : theme.colors.bgCard,
                            borderWidth: editBtnFocused ? theme.focus.ringWidth : 1,
                            borderColor: editBtnFocused
                              ? theme.colors.focusRingColor
                              : theme.colors.surfaceBorder,
                            borderRadius: theme.radius.button,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            theme.typography.caption,
                            {
                              color: theme.colors.textPrimary,
                              fontWeight: editBtnFocused ? '700' : '500',
                            },
                          ]}
                        >
                          {i18n.t('channels.manage.editGroup')}
                        </Text>
                      </Pressable>
                      <Pressable
                        testID={`channel-manage-delete-group-${group.id}`}
                        focusable={!isTv}
                        accessibilityRole="button"
                        accessibilityLabel={i18n.t('channels.manage.deleteGroup')}
                        onPress={() => void handleDeleteGroup(group.id)}
                        style={[
                          styles.btn,
                          cursor,
                          transition,
                          {
                            backgroundColor: deleteBtnFocused
                              ? theme.colors.focusFill
                              : theme.colors.bgCard,
                            borderWidth: deleteBtnFocused ? theme.focus.ringWidth : 1,
                            borderColor: deleteBtnFocused
                              ? theme.colors.focusRingColor
                              : theme.colors.liveColor,
                            borderRadius: theme.radius.button,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            theme.typography.caption,
                            {
                              color: theme.colors.liveColor,
                              fontWeight: deleteBtnFocused ? '700' : '500',
                            },
                          ]}
                        >
                          {i18n.t('channels.manage.deleteGroup')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                )}

                {isExpanded ? (
                  <View
                    testID={`channel-manage-group-members-${group.id}`}
                    style={[styles.membersWrap, { borderTopColor: theme.colors.surfaceBorder }]}
                  >
                    {members.length === 0 ? (
                      <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                        {i18n.t('channels.manage.groupEmpty')}
                      </Text>
                    ) : (
                      members.map((ch) => {
                        const removeFocused =
                          activeFocusRow?.kind === 'member' &&
                          activeFocusRow.groupId === group.id &&
                          activeFocusRow.itemKey === ch.key;
                        return (
                          <View
                            key={ch.key}
                            testID={`channel-manage-group-member-${group.id}-${ch.key}`}
                            style={styles.memberRow}
                          >
                            <Text
                              numberOfLines={1}
                              style={[
                                theme.typography.body,
                                styles.flex1,
                                { color: theme.colors.textPrimary },
                              ]}
                            >
                              {ch.name}
                            </Text>
                            <Pressable
                              testID={`channel-manage-remove-member-${group.id}-${ch.key}`}
                              focusable={!isTv}
                              accessibilityRole="button"
                              accessibilityLabel={i18n.t('channels.manage.removeFromGroup')}
                              onPress={() => void handleRemoveMember(group.id, ch.key)}
                              style={[
                                styles.btn,
                                cursor,
                                transition,
                                {
                                  backgroundColor: removeFocused
                                    ? theme.colors.focusFill
                                    : theme.colors.bgCard,
                                  borderWidth: removeFocused ? theme.focus.ringWidth : 1,
                                  borderColor: removeFocused
                                    ? theme.colors.focusRingColor
                                    : theme.colors.surfaceBorder,
                                  borderRadius: theme.radius.button,
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  theme.typography.caption,
                                  {
                                    color: removeFocused
                                      ? theme.colors.textPrimary
                                      : theme.colors.textSecondary,
                                    fontWeight: removeFocused ? '700' : '500',
                                  },
                                ]}
                              >
                                {i18n.t('channels.manage.removeFromGroup')}
                              </Text>
                            </Pressable>
                          </View>
                        );
                      })
                    )}
                  </View>
                ) : null}
              </Surface>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
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
  groupCard: { padding: 12, gap: 10 },
  groupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  groupTitleArea: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 140 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  btn: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membersWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    gap: 8,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  flex1: { flex: 1 },
});

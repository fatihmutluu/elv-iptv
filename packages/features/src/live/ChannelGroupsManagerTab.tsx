import {
  type CatalogService,
  type CustomGroupRecord,
  customGroupCategoryId,
  type ItemRow,
} from '@elv/data';
import {
  CtaButton,
  MicroPill,
  Surface,
  TvTextInput,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Props of {@link ChannelGroupsManagerTab}. */
export interface ChannelGroupsManagerTabProps {
  readonly catalog: CatalogService;
  readonly groups: readonly CustomGroupRecord[];
  readonly isTv: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onMutated?: () => void;
}

/**
 * Custom groups management tab inside {@link ChannelManagementOverlay} (`#60`).
 * Supports creating, renaming, deleting custom groups, and viewing/removing member channels.
 */
export function ChannelGroupsManagerTab({
  catalog,
  groups,
  isTv,
  onRefresh,
  onMutated,
}: ChannelGroupsManagerTabProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [membersByGroupId, setMembersByGroupId] = useState<Record<string, readonly ItemRow[]>>({});
  const [busy, setBusy] = useState(false);

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

  const handleCreateGroup = useCallback(async () => {
    const trimmed = newGroupName.trim();
    if (trimmed.length === 0 || !catalog.createCustomGroup || busy) return;
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
  }, [busy, catalog, newGroupName, onMutated, onRefresh]);

  const handleSaveRename = useCallback(
    async (groupId: string) => {
      const trimmed = editingGroupName.trim();
      if (trimmed.length === 0 || !catalog.updateCustomGroup || busy) return;
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
    [busy, catalog, editingGroupName, onMutated, onRefresh],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!catalog.deleteCustomGroup || busy) return;
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
    [busy, catalog, editingGroupId, expandedGroupId, onMutated, onRefresh],
  );

  const handleRemoveMember = useCallback(
    async (groupId: string, itemKey: string) => {
      if (!catalog.removeChannelFromCustomGroup || busy) return;
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
    [busy, catalog, loadGroupMembers, onMutated, onRefresh],
  );

  return (
    <View testID="channel-manage-groups-tab-content" style={styles.root}>
      <View style={styles.createRow}>
        <TvTextInput
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
              backgroundColor: theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
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
        <View style={styles.groupList}>
          {groups.map((group) => {
            const isEditing = editingGroupId === group.id;
            const isExpanded = expandedGroupId === group.id;
            const members = membersByGroupId[group.id] ?? [];

            return (
              <Surface
                key={group.id}
                testID={`channel-manage-group-row-${group.id}`}
                tone="surface"
                bordered
                rounded="card"
                style={styles.groupCard}
              >
                {isEditing ? (
                  <View style={styles.createRow}>
                    <TvTextInput
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
                          backgroundColor: theme.colors.bgCard,
                          borderColor: theme.colors.accent,
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
                      onPress={() => void handleSaveRename(group.id)}
                    />
                    <CtaButton
                      testID={`channel-manage-cancel-group-${group.id}`}
                      label={i18n.t('channels.manage.cancel')}
                      variant="secondary"
                      focusable={!isTv}
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
                      accessibilityRole="button"
                      accessibilityLabel={group.name}
                      onPress={() => setExpandedGroupId(isExpanded ? null : group.id)}
                      style={[styles.groupTitleArea, cursor]}
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
                            backgroundColor: theme.colors.bgCard,
                            borderColor: theme.colors.surfaceBorder,
                            borderRadius: theme.radius.button,
                          },
                        ]}
                      >
                        <Text
                          style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
                        >
                          {i18n.t('channels.manage.editGroup')}
                        </Text>
                      </Pressable>
                      <Pressable
                        testID={`channel-manage-delete-group-${group.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={i18n.t('channels.manage.deleteGroup')}
                        onPress={() => void handleDeleteGroup(group.id)}
                        style={[
                          styles.btn,
                          cursor,
                          transition,
                          {
                            backgroundColor: theme.colors.bgCard,
                            borderColor: theme.colors.liveColor,
                            borderRadius: theme.radius.button,
                          },
                        ]}
                      >
                        <Text style={[theme.typography.caption, { color: theme.colors.liveColor }]}>
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
                      members.map((ch) => (
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
                            accessibilityRole="button"
                            accessibilityLabel={i18n.t('channels.manage.removeFromGroup')}
                            onPress={() => void handleRemoveMember(group.id, ch.key)}
                            style={[
                              styles.btn,
                              cursor,
                              transition,
                              {
                                backgroundColor: theme.colors.bgCard,
                                borderColor: theme.colors.surfaceBorder,
                                borderRadius: theme.radius.button,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                theme.typography.caption,
                                { color: theme.colors.textSecondary },
                              ]}
                            >
                              {i18n.t('channels.manage.removeFromGroup')}
                            </Text>
                          </Pressable>
                        </View>
                      ))
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

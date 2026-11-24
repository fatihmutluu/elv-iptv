import type { FailoverGroupRecord, ItemRow } from '@elv/data';
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
import type { MutableRefObject, ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type FailoverTabFocusRow, formatFailoverMemberLabel } from './failover-groups-model';
import { SourceBadgePill } from './SourceBadgePill';
import type { SourceBadgeInfo } from './source-badge';

/** Props of {@link FailoverGroupCard}. */
export interface FailoverGroupCardProps {
  readonly group: FailoverGroupRecord;
  readonly channelsByKey: ReadonlyMap<string, ItemRow>;
  readonly availableChannels: readonly ItemRow[];
  readonly resolveBadge: (sourceId: string, fallbackName?: string) => SourceBadgeInfo | null;
  readonly isPickingChannel: boolean;
  readonly isRenaming: boolean;
  readonly renameDraft: string;
  readonly renameInputRef?: MutableRefObject<TvTextInputInstance | null>;
  readonly canRename: boolean;
  readonly isTv: boolean;
  readonly activeFocusRow: FailoverTabFocusRow | null;
  readonly focusedCol: number;
  readonly busy: boolean;
  readonly onLayoutY: (y: number) => void;
  readonly onTogglePicker: () => void;
  readonly onStartRename: () => void;
  readonly onChangeRenameDraft: (text: string) => void;
  readonly onSaveRename: () => void;
  readonly onCancelRename: () => void;
  readonly onDeleteGroup: () => void;
  readonly onPickChannel: (channelKey: string) => void;
  readonly onMoveMember: (index: number, delta: -1 | 1) => void;
  readonly onRemoveMember: (channelKey: string) => void;
}

/**
 * Cinema Quietude v2 hairline card for one multi-source failover group (`#157`).
 * Displays ordered backup priority rows (`#1 Primary`, `#2`, `#3`), source badges, inline rename
 * controls, inline channel picker, and Move Up / Move Down / Remove actions with 10-ft TV D-pad
 * focus rings.
 */
export function FailoverGroupCard({
  group,
  channelsByKey,
  availableChannels,
  resolveBadge,
  isPickingChannel,
  isRenaming,
  renameDraft,
  renameInputRef,
  canRename,
  isTv,
  activeFocusRow,
  focusedCol,
  busy,
  onLayoutY,
  onTogglePicker,
  onStartRename,
  onChangeRenameDraft,
  onSaveRename,
  onCancelRename,
  onDeleteGroup,
  onPickChannel,
  onMoveMember,
  onRemoveMember,
}: FailoverGroupCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  const isEditFocused =
    activeFocusRow?.kind === 'group-edit' && activeFocusRow.groupId === group.id;
  const isHeaderFocused =
    activeFocusRow?.kind === 'group-header' && activeFocusRow.groupId === group.id;
  const isCardFocused = isEditFocused || isHeaderFocused;
  const addBtnFocused = isHeaderFocused && focusedCol === 0;
  const renameBtnFocused = isHeaderFocused && focusedCol === 1;
  const deleteBtnFocused = isHeaderFocused && focusedCol === 2;
  const renameInputFocused = isEditFocused && focusedCol === 0;
  const renameSaveFocused = isEditFocused && focusedCol === 1;
  const renameCancelFocused = isEditFocused && focusedCol === 2;

  const btnStyle = (focused: boolean, danger = false, disabled = false) => [
    styles.btn,
    cursor,
    transition,
    {
      backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgCard,
      borderWidth: focused ? theme.focus.ringWidth : 1,
      borderColor: focused
        ? theme.colors.focusRingColor
        : danger
          ? theme.colors.liveColor
          : theme.colors.surfaceBorder,
      borderRadius: theme.radius.button,
      opacity: disabled ? 0.4 : 1,
    },
  ];

  return (
    <Surface
      testID={`failover-group-card-${group.id}`}
      tone="surface"
      bordered
      rounded="card"
      onLayout={(e) => onLayoutY(e.nativeEvent.layout.y)}
      style={[
        styles.card,
        isCardFocused
          ? { borderColor: theme.colors.focusRingColor, backgroundColor: theme.colors.focusFill }
          : null,
      ]}
    >
      {isRenaming ? (
        <View style={styles.renameRow}>
          <TvTextInput
            ref={renameInputRef}
            testID={`failover-rename-input-${group.id}`}
            value={renameDraft}
            onChangeText={onChangeRenameDraft}
            placeholder={i18n.t('channels.failover.createPlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel={i18n.t('channels.manage.rename')}
            onSubmitEditing={onSaveRename}
            style={[
              styles.renameInput,
              theme.typography.body,
              {
                color: theme.colors.textPrimary,
                backgroundColor: renameInputFocused ? theme.colors.focusFill : theme.colors.bgCard,
                borderWidth: renameInputFocused ? theme.focus.ringWidth : 1,
                borderColor: renameInputFocused ? theme.colors.focusRingColor : theme.colors.accent,
                borderRadius: theme.radius.button,
              },
            ]}
          />
          <CtaButton
            testID={`failover-rename-save-btn-${group.id}`}
            label={i18n.t('channels.manage.save')}
            variant="primary"
            disabled={busy || !canRename || renameDraft.trim().length === 0}
            focusable={!isTv}
            focused={renameSaveFocused}
            onPress={onSaveRename}
          />
          <CtaButton
            testID={`failover-rename-cancel-btn-${group.id}`}
            label={i18n.t('channels.manage.cancel')}
            variant="secondary"
            disabled={busy}
            focusable={!isTv}
            focused={renameCancelFocused}
            onPress={onCancelRename}
          />
        </View>
      ) : (
        <View style={styles.headerRow}>
          <View style={styles.titleArea}>
            <Text
              numberOfLines={1}
              style={[theme.typography.title, { color: theme.colors.textPrimary }]}
            >
              {group.name}
            </Text>
            <MicroPill
              testID={`failover-group-count-${group.id}`}
              label={i18n.t('channels.failover.memberCount', { count: group.members.length })}
              tone="neutral"
            />
          </View>
          <View style={styles.actionsRow}>
            <Pressable
              testID={`failover-add-channel-btn-${group.id}`}
              focusable={!isTv}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={i18n.t('channels.failover.addChannel')}
              onPress={onTogglePicker}
              style={btnStyle(addBtnFocused)}
            >
              <Text
                style={[
                  theme.typography.caption,
                  {
                    color: theme.colors.textPrimary,
                    fontWeight: addBtnFocused ? '700' : '500',
                  },
                ]}
              >
                {i18n.t('channels.failover.addChannel')}
              </Text>
            </Pressable>
            <Pressable
              testID={`failover-rename-group-btn-${group.id}`}
              focusable={!isTv}
              disabled={busy || !canRename}
              accessibilityRole="button"
              accessibilityLabel={i18n.t('channels.manage.rename')}
              onPress={onStartRename}
              style={btnStyle(renameBtnFocused, false, !canRename)}
            >
              <Text
                style={[
                  theme.typography.caption,
                  {
                    color: theme.colors.textPrimary,
                    fontWeight: renameBtnFocused ? '700' : '500',
                  },
                ]}
              >
                {i18n.t('channels.manage.rename')}
              </Text>
            </Pressable>
            <Pressable
              testID={`failover-delete-group-btn-${group.id}`}
              focusable={!isTv}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={i18n.t('channels.failover.deleteGroup')}
              onPress={onDeleteGroup}
              style={btnStyle(deleteBtnFocused, true)}
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
                {i18n.t('channels.failover.deleteGroup')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {isPickingChannel ? (
        <View
          testID={`failover-channel-picker-${group.id}`}
          style={[styles.pickerWrap, { borderTopColor: theme.colors.surfaceBorder }]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('channels.failover.selectChannelHint')}
          </Text>
          <View style={styles.pickerList}>
            {availableChannels.map((ch) => {
              const pickFocused =
                activeFocusRow?.kind === 'picker-channel' &&
                activeFocusRow.groupId === group.id &&
                activeFocusRow.channelKey === ch.key;
              return (
                <Pressable
                  key={ch.key}
                  testID={`failover-pick-channel-${group.id}-${ch.key}`}
                  focusable={!isTv}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={ch.name}
                  onPress={() => onPickChannel(ch.key)}
                  style={[
                    styles.pickerItem,
                    cursor,
                    transition,
                    {
                      backgroundColor: pickFocused ? theme.colors.focusFill : theme.colors.bgCard,
                      borderWidth: pickFocused ? theme.focus.ringWidth : 1,
                      borderColor: pickFocused
                        ? theme.colors.focusRingColor
                        : theme.colors.surfaceBorder,
                      borderRadius: theme.radius.button,
                    },
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.caption,
                      styles.flex1,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {ch.name}
                  </Text>
                  <SourceBadgePill badge={resolveBadge(ch.sourceId)} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {group.members.length > 0 ? (
        <View style={[styles.membersWrap, { borderTopColor: theme.colors.surfaceBorder }]}>
          {group.members.map((member, idx) => {
            const isMemberRowFocused =
              activeFocusRow?.kind === 'member' &&
              activeFocusRow.groupId === group.id &&
              activeFocusRow.channelKey === member.channelKey;
            const upFocused = isMemberRowFocused && focusedCol === 0;
            const downFocused = isMemberRowFocused && focusedCol === 1;
            const removeFocused = isMemberRowFocused && focusedCol === 2;
            const canMoveUp = idx > 0;
            const canMoveDown = idx < group.members.length - 1;
            const label = formatFailoverMemberLabel(member, channelsByKey);

            return (
              <View
                key={member.channelKey}
                testID={`failover-member-row-${group.id}-${member.channelKey}`}
                style={styles.memberRow}
              >
                <View style={styles.memberInfo}>
                  <MicroPill
                    testID={`failover-member-rank-${group.id}-${member.channelKey}`}
                    label={i18n.t('channels.failover.priorityBadge', { rank: idx + 1 })}
                    tone={idx === 0 ? 'accent' : 'neutral'}
                  />
                  {idx === 0 ? (
                    <MicroPill
                      testID={`failover-member-primary-${group.id}-${member.channelKey}`}
                      label={i18n.t('channels.failover.primaryBadge')}
                      tone="success"
                    />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.body,
                      styles.flex1,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {label}
                  </Text>
                  <SourceBadgePill badge={resolveBadge(member.sourceId, member.sourceName)} />
                </View>

                <View style={styles.actionsRow}>
                  <Pressable
                    testID={`failover-member-up-${group.id}-${member.channelKey}`}
                    focusable={!isTv}
                    disabled={busy || !canMoveUp}
                    accessibilityRole="button"
                    accessibilityLabel={i18n.t('channels.failover.moveUp')}
                    onPress={() => onMoveMember(idx, -1)}
                    style={btnStyle(upFocused, false, !canMoveUp)}
                  >
                    <Text
                      style={[
                        theme.typography.caption,
                        {
                          color: theme.colors.textPrimary,
                          fontWeight: upFocused ? '700' : '500',
                        },
                      ]}
                    >
                      {i18n.t('channels.failover.moveUp')}
                    </Text>
                  </Pressable>
                  <Pressable
                    testID={`failover-member-down-${group.id}-${member.channelKey}`}
                    focusable={!isTv}
                    disabled={busy || !canMoveDown}
                    accessibilityRole="button"
                    accessibilityLabel={i18n.t('channels.failover.moveDown')}
                    onPress={() => onMoveMember(idx, 1)}
                    style={btnStyle(downFocused, false, !canMoveDown)}
                  >
                    <Text
                      style={[
                        theme.typography.caption,
                        {
                          color: theme.colors.textPrimary,
                          fontWeight: downFocused ? '700' : '500',
                        },
                      ]}
                    >
                      {i18n.t('channels.failover.moveDown')}
                    </Text>
                  </Pressable>
                  <Pressable
                    testID={`failover-member-remove-${group.id}-${member.channelKey}`}
                    focusable={!isTv}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={i18n.t('channels.failover.removeMember')}
                    onPress={() => onRemoveMember(member.channelKey)}
                    style={btnStyle(removeFocused)}
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
                      {i18n.t('channels.failover.removeMember')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, gap: 10 },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  renameInput: {
    flex: 1,
    minWidth: 160,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  titleArea: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 140 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  btn: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    gap: 8,
  },
  pickerList: { gap: 6 },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
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
    flexWrap: 'wrap',
  },
  memberInfo: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 },
  flex1: { flex: 1 },
});

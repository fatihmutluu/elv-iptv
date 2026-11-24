import type { CustomGroupRecord, ItemRow } from '@elv/data';
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
import type { ReactElement, Ref } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ChannelRowAction } from './channel-management-model';

/** Props of {@link ChannelManagementRow}. */
export interface ChannelManagementRowProps {
  readonly channel: ItemRow;
  readonly groups: readonly CustomGroupRecord[];
  readonly isTv: boolean;
  readonly isRowFocused: boolean;
  readonly focusedAction: ChannelRowAction | null;
  readonly isRenaming: boolean;
  readonly renameDraft: string;
  readonly renameCol: 0 | 1 | 2;
  readonly renameInputRef?: Ref<TvTextInputInstance>;
  readonly isPickingGroup: boolean;
  readonly groupPickerIdx: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly busy: boolean;
  readonly onLayoutY?: (y: number) => void;
  readonly onStartRename: () => void;
  readonly onChangeRenameDraft: (text: string) => void;
  readonly onSaveRename: () => void;
  readonly onCancelRename: () => void;
  readonly onResetName: () => void;
  readonly onToggleHidden: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onToggleGroupPicker: () => void;
  readonly onPickGroup: (groupId: string) => void;
}

/** One channel management row card with Cinema Quietude TV focus rings, inline rename, and group picker. */
export function ChannelManagementRow(p: ChannelManagementRowProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const { channel: ch, isTv, isRowFocused, focusedAction } = p;
  const isRenamed = ch.originalName !== undefined && ch.originalName !== null;

  return (
    <Surface
      testID={`channel-manage-row-${ch.key}`}
      tone="surface"
      bordered
      rounded="card"
      onLayout={(e) => p.onLayoutY?.(e.nativeEvent.layout.y)}
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
          <RowActionBtn
            testID={`channel-manage-rename-${ch.key}`}
            label={i18n.t('channels.manage.rename')}
            isTv={isTv}
            focused={focusedAction === 'rename'}
            onPress={p.onStartRename}
          />
          {isRenamed ? (
            <RowActionBtn
              testID={`channel-manage-reset-name-${ch.key}`}
              label={i18n.t('channels.manage.resetName')}
              isTv={isTv}
              focused={focusedAction === 'resetName'}
              onPress={p.onResetName}
            />
          ) : null}
          <RowActionBtn
            testID={`channel-manage-toggle-hide-${ch.key}`}
            label={i18n.t(ch.isHidden === true ? 'channels.manage.unhide' : 'channels.manage.hide')}
            isTv={isTv}
            focused={focusedAction === 'toggleHide'}
            onPress={p.onToggleHidden}
          />
          <RowActionBtn
            testID={`channel-manage-move-up-${ch.key}`}
            label={i18n.t('channels.manage.moveUp')}
            isTv={isTv}
            focused={focusedAction === 'moveUp'}
            disabled={!p.canMoveUp || p.busy}
            onPress={p.onMoveUp}
          />
          <RowActionBtn
            testID={`channel-manage-move-down-${ch.key}`}
            label={i18n.t('channels.manage.moveDown')}
            isTv={isTv}
            focused={focusedAction === 'moveDown'}
            disabled={!p.canMoveDown || p.busy}
            onPress={p.onMoveDown}
          />
          {p.groups.length > 0 ? (
            <RowActionBtn
              testID={`channel-manage-add-to-group-${ch.key}`}
              label={i18n.t('channels.manage.addToGroup')}
              isTv={isTv}
              focused={focusedAction === 'addToGroup'}
              onPress={p.onToggleGroupPicker}
            />
          ) : null}
        </View>
      </View>

      {p.isRenaming ? (
        <View style={styles.inlineEditor}>
          <TvTextInput
            {...(p.renameInputRef !== undefined ? { ref: p.renameInputRef } : {})}
            testID={`channel-manage-rename-input-${ch.key}`}
            value={p.renameDraft}
            onChangeText={p.onChangeRenameDraft}
            placeholder={i18n.t('channels.manage.renamePlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            onSubmitEditing={p.onSaveRename}
            style={[
              styles.input,
              theme.typography.body,
              {
                color: theme.colors.textPrimary,
                backgroundColor:
                  isRowFocused && p.renameCol === 0 ? theme.colors.focusFill : theme.colors.bgCard,
                borderWidth: isRowFocused && p.renameCol === 0 ? theme.focus.ringWidth : 1,
                borderColor:
                  isRowFocused && p.renameCol === 0
                    ? theme.colors.focusRingColor
                    : theme.colors.accent,
                borderRadius: theme.radius.button,
              },
            ]}
          />
          <CtaButton
            testID={`channel-manage-rename-save-${ch.key}`}
            label={i18n.t('channels.manage.save')}
            variant="primary"
            disabled={p.busy}
            focusable={!isTv}
            focused={isRowFocused && p.renameCol === 1}
            onPress={p.onSaveRename}
          />
          <CtaButton
            testID={`channel-manage-rename-cancel-${ch.key}`}
            label={i18n.t('channels.manage.cancel')}
            variant="secondary"
            focusable={!isTv}
            focused={isRowFocused && p.renameCol === 2}
            onPress={p.onCancelRename}
          />
        </View>
      ) : null}

      {p.isPickingGroup ? (
        <View testID={`channel-manage-group-picker-${ch.key}`} style={styles.groupPickerRow}>
          {p.groups.map((g, gIdx) => {
            const chipFocused = isRowFocused && p.groupPickerIdx === gIdx;
            return (
              <Pressable
                key={g.id}
                testID={`channel-manage-pick-group-${ch.key}-${g.id}`}
                focusable={!isTv}
                accessibilityRole="button"
                accessibilityLabel={g.name}
                onPress={() => p.onPickGroup(g.id)}
                style={[
                  styles.groupPickChip,
                  cursor,
                  transition,
                  {
                    backgroundColor: chipFocused ? theme.colors.focusFill : theme.colors.bgCard,
                    borderWidth: chipFocused ? theme.focus.ringWidth : 1,
                    borderColor: chipFocused ? theme.colors.focusRingColor : theme.colors.accent,
                    borderRadius: theme.radius.button,
                  },
                ]}
              >
                <Text
                  style={[
                    theme.typography.caption,
                    {
                      color: theme.colors.textPrimary,
                      fontWeight: chipFocused ? '700' : '500',
                    },
                  ]}
                >
                  {g.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </Surface>
  );
}

function RowActionBtn({
  testID,
  label,
  isTv,
  focused,
  disabled = false,
  onPress,
}: {
  readonly testID: string;
  readonly label: string;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  return (
    <Pressable
      testID={testID}
      focusable={!isTv}
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
          backgroundColor: focused
            ? theme.colors.focusFill
            : pressed
              ? theme.colors.subtleHighlight
              : theme.colors.bgCard,
          borderWidth: focused ? theme.focus.ringWidth : 1,
          borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          theme.typography.caption,
          { color: theme.colors.textPrimary, fontWeight: focused ? '700' : '500' },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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

import type { GuideChannelOption } from '@elv/data';
import {
  CtaButton,
  FilterChip,
  TABULAR_NUMS_STYLE,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import type { MutableRefObject, ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  type ChannelMapperFocusRow,
  clampOffsetHours,
  formatSignedOffsetHours,
  MAX_EPG_OFFSET_HOURS,
  MIN_EPG_OFFSET_HOURS,
} from './guide-management-model';

/** Props of {@link ChannelMapperEditor}. */
export interface ChannelMapperEditorProps {
  readonly channelKey: string;
  readonly hasExistingOverride: boolean;
  readonly guideQuery: string;
  readonly onChangeGuideQuery: (value: string) => void;
  readonly guideOptions: readonly GuideChannelOption[];
  readonly selectedGuideId: string | null;
  readonly onSelectGuideOption: (opt: GuideChannelOption) => void;
  readonly offsetHours: number;
  readonly onChangeOffsetHours: (next: number) => void;
  readonly guideSearchInputRef: MutableRefObject<TvTextInputInstance | null>;
  readonly isTv: boolean;
  readonly isChannelRowFocused: boolean;
  readonly activeFocusRow: ChannelMapperFocusRow | undefined;
  readonly focusedCol: number;
  readonly focusedGuideOptionId: string | null;
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onClear: () => void;
  readonly onCancel: () => void;
}

/** Inline guide picker, per-channel time-offset stepper, and save/reset/cancel actions for `ChannelMapperTab` (`#30`). */
export function ChannelMapperEditor({
  channelKey,
  hasExistingOverride,
  guideQuery,
  onChangeGuideQuery,
  guideOptions,
  selectedGuideId,
  onSelectGuideOption,
  offsetHours,
  onChangeOffsetHours,
  guideSearchInputRef,
  isTv,
  isChannelRowFocused,
  activeFocusRow,
  focusedCol,
  focusedGuideOptionId,
  busy,
  onSave,
  onClear,
  onCancel,
}: ChannelMapperEditorProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <View testID={`mapper-editor-${channelKey}`} style={styles.editor}>
      <TvTextInput
        ref={guideSearchInputRef}
        testID={`mapper-guide-search-${channelKey}`}
        value={guideQuery}
        onChangeText={onChangeGuideQuery}
        placeholder={i18n.t('sources.guides.searchPlaceholder')}
        placeholderTextColor={theme.colors.textMuted}
        accessibilityLabel={i18n.t('sources.guides.assignGuide')}
        style={[
          styles.input,
          theme.typography.body,
          {
            color: theme.colors.textPrimary,
            backgroundColor: theme.colors.bgSurface,
            borderColor:
              isChannelRowFocused && activeFocusRow?.kind === 'editor-search'
                ? theme.colors.focusRingColor
                : theme.colors.surfaceBorder,
            borderWidth:
              isChannelRowFocused && activeFocusRow?.kind === 'editor-search'
                ? theme.focus.ringWidth
                : 1,
            borderRadius: theme.radius.button,
          },
        ]}
      />

      {guideOptions.length === 0 ? (
        <Text
          testID="mapper-no-guide-channels"
          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
        >
          {i18n.t('sources.guides.noGuideChannels')}
        </Text>
      ) : (
        <View style={styles.guideOptionsWrap}>
          {guideOptions.slice(0, 12).map((opt) => (
            <FilterChip
              key={opt.guideId}
              testID={`mapper-guide-option-${opt.guideId}`}
              label={`${opt.name} (${opt.guideId})`}
              selected={selectedGuideId === opt.guideId}
              focusable={!isTv}
              focused={
                isChannelRowFocused &&
                activeFocusRow?.kind === 'editor-options' &&
                focusedGuideOptionId === opt.guideId
              }
              onPress={() => onSelectGuideOption(opt)}
            />
          ))}
        </View>
      )}

      <View style={styles.offsetRow}>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('sources.guides.channelOffsetLabel')}
        </Text>
        <View style={styles.stepperGroup}>
          <CtaButton
            testID={`mapper-offset-dec-${channelKey}`}
            variant="secondary"
            label="-1h"
            disabled={offsetHours <= MIN_EPG_OFFSET_HOURS}
            focusable={!isTv}
            focused={
              isChannelRowFocused &&
              activeFocusRow?.kind === 'editor-offset' &&
              activeFocusRow.slots[focusedCol] === 'editor-offset-dec'
            }
            onPress={() => onChangeOffsetHours(clampOffsetHours(offsetHours - 1))}
          />
          <Text
            testID={`mapper-offset-value-${channelKey}`}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              styles.offsetValue,
              { color: theme.colors.textPrimary },
            ]}
          >
            {i18n.t('sources.guides.offsetHours', {
              hours: formatSignedOffsetHours(offsetHours),
            })}
          </Text>
          <CtaButton
            testID={`mapper-offset-inc-${channelKey}`}
            variant="secondary"
            label="+1h"
            disabled={offsetHours >= MAX_EPG_OFFSET_HOURS}
            focusable={!isTv}
            focused={
              isChannelRowFocused &&
              activeFocusRow?.kind === 'editor-offset' &&
              activeFocusRow.slots[focusedCol] === 'editor-offset-inc'
            }
            onPress={() => onChangeOffsetHours(clampOffsetHours(offsetHours + 1))}
          />
        </View>
      </View>

      <View style={styles.rowActions}>
        <CtaButton
          testID={`mapper-save-${channelKey}`}
          variant="primary"
          label={i18n.t('sources.guides.save')}
          disabled={busy}
          focusable={!isTv}
          focused={
            isChannelRowFocused &&
            activeFocusRow?.kind === 'editor-actions' &&
            activeFocusRow.slots[focusedCol] === 'editor-save'
          }
          onPress={onSave}
        />
        {hasExistingOverride ? (
          <CtaButton
            testID={`mapper-editor-clear-${channelKey}`}
            variant="secondary"
            label={i18n.t('sources.guides.clearOverride')}
            disabled={busy}
            focusable={!isTv}
            focused={
              isChannelRowFocused &&
              activeFocusRow?.kind === 'editor-actions' &&
              activeFocusRow.slots[focusedCol] === 'editor-clear'
            }
            onPress={onClear}
          />
        ) : null}
        <CtaButton
          testID={`mapper-cancel-${channelKey}`}
          variant="secondary"
          label={i18n.t('sources.guides.cancel')}
          disabled={busy}
          focusable={!isTv}
          focused={
            isChannelRowFocused &&
            activeFocusRow?.kind === 'editor-actions' &&
            activeFocusRow.slots[focusedCol] === 'editor-cancel'
          }
          onPress={onCancel}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { gap: 10, paddingTop: 4 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
  },
  guideOptionsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  offsetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
  },
  stepperGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  offsetValue: { minWidth: 44, textAlign: 'center', fontWeight: '700' },
  rowActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});

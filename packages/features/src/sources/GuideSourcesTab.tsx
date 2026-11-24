import type { CatalogService, GuideSourceRecord } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  MicroPill,
  Surface,
  TABULAR_NUMS_STYLE,
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
import { describeSourceFailure } from './errors';
import {
  buildGuideSourcesFocusRows,
  clampOffsetHours,
  formatSignedOffsetHours,
  type GuideRowActionSlot,
  MAX_EPG_OFFSET_HOURS,
  MIN_EPG_OFFSET_HOURS,
  offsetHoursToMs,
  offsetMsToHours,
  reorderGuideSourceIds,
  validateGuideSourceDraft,
} from './guide-management-model';

/** Props of {@link GuideSourcesTab}. */
export interface GuideSourcesTabProps {
  readonly sourceId: string;
  readonly catalog: CatalogService;
  readonly guides: readonly GuideSourceRecord[];
  readonly isTv: boolean;
  readonly tvActive?: boolean;
  readonly tvKeyHandlerRef?: MutableRefObject<((key: KeyInput['key']) => boolean) | null>;
  readonly onEdgeTop?: () => void;
  readonly onScrollToY?: (y: number) => void;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onMutated?: () => void;
}

/**
 * Priority-ordered XMLTV guide sources management tab (`#30`):
 * add/remove/reorder multiple XMLTV URLs per source, toggle enabled state, adjust per-guide
 * `-12h..+12h` EPG time offsets, and navigate every control via 10-ft TV D-pad.
 */
export function GuideSourcesTab({
  sourceId,
  catalog,
  guides,
  isTv,
  tvActive = false,
  tvKeyHandlerRef,
  onEdgeTop,
  onScrollToY,
  busy,
  onBusyChange,
  onRefresh,
  onMutated,
}: GuideSourcesTabProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const [adding, setAdding] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [offsetHoursDraft, setOffsetHoursDraft] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [focusedRow, setFocusedRow] = useState(0);
  const [focusedCol, setFocusedCol] = useState(0);
  const nameInputRef = useRef<TvTextInputInstance | null>(null);
  const urlInputRef = useRef<TvTextInputInstance | null>(null);
  const listYRef = useRef(0);
  const rowYRef = useRef<Record<string, number>>({});

  const focusRows = useMemo(() => buildGuideSourcesFocusRows(guides, adding), [adding, guides]);

  useEffect(() => {
    setFocusedRow((prevRow) => {
      const clampedRow = Math.min(prevRow, Math.max(0, focusRows.length - 1));
      const maxCol = Math.max(0, (focusRows[clampedRow]?.slots.length ?? 1) - 1);
      setFocusedCol((prevCol) => Math.min(prevCol, maxCol));
      return clampedRow;
    });
  }, [focusRows]);

  useEffect(() => {
    if (!isTv || !tvActive || onScrollToY === undefined) return;
    const row = focusRows[focusedRow];
    if (row?.kind !== 'guide') {
      onScrollToY(0);
      return;
    }
    const cardY = rowYRef.current[row.guideId];
    onScrollToY(cardY !== undefined ? listYRef.current + cardY : focusedRow * 96);
  }, [focusRows, focusedRow, isTv, onScrollToY, tvActive]);

  const resetAddForm = useCallback(() => {
    setAdding(false);
    setNameDraft('');
    setUrlDraft('');
    setOffsetHoursDraft(0);
    setErrorText(null);
    setFocusedRow(0);
    setFocusedCol(0);
  }, []);

  const handleSaveNewGuide = useCallback(async () => {
    if (!catalog.addGuideSource || busy) return;
    const validation = validateGuideSourceDraft(nameDraft, urlDraft);
    if (validation === 'missing-name') {
      setErrorText(i18n.t('sources.guides.namePlaceholder'));
      return;
    }
    if (validation === 'invalid-url') {
      setErrorText(i18n.t('source.validation.invalidGuideUrl'));
      return;
    }
    setErrorText(null);
    onBusyChange(true);
    try {
      const res = await catalog.addGuideSource({
        sourceId,
        name: nameDraft.trim(),
        url: urlDraft.trim(),
        epgShiftMs: offsetHoursToMs(offsetHoursDraft),
      });
      if (!res.ok) {
        const msgId =
          res.error.code === 'invalid-guide-url'
            ? 'source.validation.invalidGuideUrl'
            : describeSourceFailure(res.error).messageId;
        setErrorText(i18n.t(msgId));
        return;
      }
      resetAddForm();
      await onRefresh();
      onMutated?.();
    } finally {
      onBusyChange(false);
    }
  }, [
    busy,
    catalog,
    i18n,
    nameDraft,
    offsetHoursDraft,
    onBusyChange,
    onMutated,
    onRefresh,
    resetAddForm,
    sourceId,
    urlDraft,
  ]);

  const handleReorder = useCallback(
    async (index: number, delta: -1 | 1) => {
      if (!catalog.reorderGuideSources || busy) return;
      const nextIds = reorderGuideSourceIds(guides, index, delta);
      if (nextIds === null) return;
      onBusyChange(true);
      try {
        const res = await catalog.reorderGuideSources(sourceId, nextIds);
        if (res.ok) {
          await onRefresh();
          onMutated?.();
        }
      } finally {
        onBusyChange(false);
      }
    },
    [busy, catalog, guides, onBusyChange, onMutated, onRefresh, sourceId],
  );

  const handleStepOffset = useCallback(
    async (guide: GuideSourceRecord, deltaHours: -1 | 1) => {
      if (!catalog.updateGuideSource || busy) return;
      const nextHours = clampOffsetHours(offsetMsToHours(guide.epgShiftMs) + deltaHours);
      const nextShiftMs = offsetHoursToMs(nextHours);
      if (nextShiftMs === guide.epgShiftMs) return;
      onBusyChange(true);
      try {
        const res = await catalog.updateGuideSource(guide.id, { epgShiftMs: nextShiftMs });
        if (res.ok) {
          await onRefresh();
          onMutated?.();
        }
      } finally {
        onBusyChange(false);
      }
    },
    [busy, catalog, onBusyChange, onMutated, onRefresh],
  );

  const handleToggleEnabled = useCallback(
    async (guide: GuideSourceRecord) => {
      if (!catalog.updateGuideSource || busy) return;
      onBusyChange(true);
      try {
        const res = await catalog.updateGuideSource(guide.id, { enabled: !guide.enabled });
        if (res.ok) {
          await onRefresh();
          onMutated?.();
        }
      } finally {
        onBusyChange(false);
      }
    },
    [busy, catalog, onBusyChange, onMutated, onRefresh],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      if (!catalog.removeGuideSource || busy) return;
      onBusyChange(true);
      try {
        const res = await catalog.removeGuideSource(id);
        if (res.ok) {
          await onRefresh();
          onMutated?.();
        }
      } finally {
        onBusyChange(false);
      }
    },
    [busy, catalog, onBusyChange, onMutated, onRefresh],
  );

  const handleTvKey = useCallback(
    (key: KeyInput['key']): boolean => {
      if (key === 'back') {
        if (adding) {
          resetAddForm();
          return true;
        }
        return false;
      }
      if (key === 'up') {
        if (focusedRow === 0) {
          onEdgeTop?.();
          return true;
        }
        const nextRow = focusedRow - 1;
        const maxCol = Math.max(0, (focusRows[nextRow]?.slots.length ?? 1) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, maxCol));
        return true;
      }
      if (key === 'down') {
        const nextRow = Math.min(Math.max(0, focusRows.length - 1), focusedRow + 1);
        const maxCol = Math.max(0, (focusRows[nextRow]?.slots.length ?? 1) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, maxCol));
        return true;
      }
      if (key === 'left') {
        setFocusedCol((c) => Math.max(0, c - 1));
        return true;
      }
      if (key === 'right') {
        const maxCol = Math.max(0, (focusRows[focusedRow]?.slots.length ?? 1) - 1);
        setFocusedCol((c) => Math.min(maxCol, c + 1));
        return true;
      }
      if (key === 'select') {
        const row = focusRows[focusedRow];
        const slot = row?.slots[focusedCol];
        if (!row || slot === undefined) return true;
        if (slot === 'add-open') {
          if (!busy && catalog.addGuideSource !== undefined) {
            setErrorText(null);
            setAdding(true);
            setFocusedRow(0);
            setFocusedCol(0);
          }
          return true;
        }
        if (slot === 'form-name') {
          nameInputRef.current?.focus();
          return true;
        }
        if (slot === 'form-url') {
          urlInputRef.current?.focus();
          return true;
        }
        if (slot === 'form-offset-dec') {
          setOffsetHoursDraft((h) => clampOffsetHours(h - 1));
          return true;
        }
        if (slot === 'form-offset-inc') {
          setOffsetHoursDraft((h) => clampOffsetHours(h + 1));
          return true;
        }
        if (slot === 'form-save') {
          void handleSaveNewGuide();
          return true;
        }
        if (slot === 'form-cancel') {
          resetAddForm();
          return true;
        }
        if (row.kind === 'guide') {
          const guide = guides[row.guideIndex];
          if (guide === undefined) return true;
          if (slot === 'row-up') void handleReorder(row.guideIndex, -1);
          else if (slot === 'row-down') void handleReorder(row.guideIndex, 1);
          else if (slot === 'row-offset-dec') void handleStepOffset(guide, -1);
          else if (slot === 'row-offset-inc') void handleStepOffset(guide, 1);
          else if (slot === 'row-toggle') void handleToggleEnabled(guide);
          else if (slot === 'row-remove') void handleRemove(guide.id);
        }
        return true;
      }
      return false;
    },
    [
      adding,
      busy,
      catalog.addGuideSource,
      focusRows,
      focusedCol,
      focusedRow,
      guides,
      handleRemove,
      handleReorder,
      handleSaveNewGuide,
      handleStepOffset,
      handleToggleEnabled,
      onEdgeTop,
      resetAddForm,
    ],
  );

  useEffect(() => {
    if (!tvKeyHandlerRef) return;
    tvKeyHandlerRef.current = handleTvKey;
    return () => {
      if (tvKeyHandlerRef.current === handleTvKey) tvKeyHandlerRef.current = null;
    };
  }, [handleTvKey, tvKeyHandlerRef]);

  const activeFocusRow = isTv && tvActive ? focusRows[focusedRow] : undefined;
  const activeSlot = activeFocusRow?.slots[focusedCol];
  const isGuideSlotFocused = (guideId: string, slot: GuideRowActionSlot): boolean =>
    activeFocusRow?.kind === 'guide' && activeFocusRow.guideId === guideId && activeSlot === slot;

  return (
    <View testID="guide-sources-tab" style={styles.container}>
      {!adding ? (
        <View style={styles.topActions}>
          <CtaButton
            testID="guide-source-open-add"
            variant="primary"
            icon="plus"
            label={i18n.t('sources.guides.addGuide')}
            disabled={busy || catalog.addGuideSource === undefined}
            focusable={!isTv}
            focused={activeFocusRow?.kind === 'add-cta' && activeSlot === 'add-open'}
            onPress={() => {
              setErrorText(null);
              setAdding(true);
            }}
          />
        </View>
      ) : (
        <Surface tone="card" bordered rounded="card" style={styles.addCard}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('sources.guides.addGuide')}
          </Text>
          <TvTextInput
            ref={nameInputRef}
            testID="guide-source-input-name"
            value={nameDraft}
            onChangeText={setNameDraft}
            placeholder={i18n.t('sources.guides.namePlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel={i18n.t('sources.guides.namePlaceholder')}
            style={[
              styles.input,
              theme.typography.body,
              {
                color: theme.colors.textPrimary,
                backgroundColor: theme.colors.bgSurface,
                borderColor:
                  activeSlot === 'form-name'
                    ? theme.colors.focusRingColor
                    : theme.colors.surfaceBorder,
                borderWidth: activeSlot === 'form-name' ? theme.focus.ringWidth : 1,
                borderRadius: theme.radius.button,
              },
            ]}
          />
          <TvTextInput
            ref={urlInputRef}
            testID="guide-source-input-url"
            value={urlDraft}
            onChangeText={setUrlDraft}
            placeholder={i18n.t('sources.guides.urlPlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel={i18n.t('sources.guides.urlPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.input,
              theme.typography.body,
              {
                color: theme.colors.textPrimary,
                backgroundColor: theme.colors.bgSurface,
                borderColor:
                  activeSlot === 'form-url'
                    ? theme.colors.focusRingColor
                    : theme.colors.surfaceBorder,
                borderWidth: activeSlot === 'form-url' ? theme.focus.ringWidth : 1,
                borderRadius: theme.radius.button,
              },
            ]}
          />
          <View style={styles.offsetRow}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('sources.guides.offsetLabel')}
            </Text>
            <View style={styles.stepperGroup}>
              <CtaButton
                testID="guide-source-draft-offset-dec"
                variant="secondary"
                label="-1h"
                disabled={offsetHoursDraft <= MIN_EPG_OFFSET_HOURS}
                focusable={!isTv}
                focused={activeSlot === 'form-offset-dec'}
                onPress={() => setOffsetHoursDraft((h) => clampOffsetHours(h - 1))}
              />
              <Text
                testID="guide-source-draft-offset-value"
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  styles.offsetValue,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {i18n.t('sources.guides.offsetHours', {
                  hours: formatSignedOffsetHours(offsetHoursDraft),
                })}
              </Text>
              <CtaButton
                testID="guide-source-draft-offset-inc"
                variant="secondary"
                label="+1h"
                disabled={offsetHoursDraft >= MAX_EPG_OFFSET_HOURS}
                focusable={!isTv}
                focused={activeSlot === 'form-offset-inc'}
                onPress={() => setOffsetHoursDraft((h) => clampOffsetHours(h + 1))}
              />
            </View>
          </View>
          {errorText !== null ? (
            <Text
              testID="guide-source-form-error"
              style={[theme.typography.caption, { color: theme.colors.liveColor }]}
            >
              {errorText}
            </Text>
          ) : null}
          <View style={styles.rowActions}>
            <CtaButton
              testID="guide-source-save"
              variant="primary"
              label={i18n.t('sources.guides.save')}
              disabled={busy}
              focusable={!isTv}
              focused={activeSlot === 'form-save'}
              onPress={() => void handleSaveNewGuide()}
            />
            <CtaButton
              testID="guide-source-cancel"
              variant="secondary"
              label={i18n.t('sources.guides.cancel')}
              disabled={busy}
              focusable={!isTv}
              focused={activeSlot === 'form-cancel'}
              onPress={resetAddForm}
            />
          </View>
        </Surface>
      )}

      {guides.length === 0 ? (
        <Text
          testID="guide-sources-empty"
          style={[theme.typography.body, { color: theme.colors.textMuted }]}
        >
          {i18n.t('sources.guides.empty')}
        </Text>
      ) : (
        <View
          style={styles.list}
          onLayout={(e) => {
            listYRef.current = e.nativeEvent.layout.y;
          }}
        >
          {guides.map((guide, idx) => {
            const offsetHours = offsetMsToHours(guide.epgShiftMs);
            return (
              <Surface
                key={guide.id}
                testID={`guide-source-row-${guide.id}`}
                tone="card"
                bordered
                rounded="card"
                style={styles.guideRow}
                onLayout={(e) => {
                  rowYRef.current[guide.id] = e.nativeEvent.layout.y;
                }}
              >
                <View style={styles.guideHeader}>
                  <Text
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {`#${idx + 1}`}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.title,
                      styles.flex1,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {guide.name}
                  </Text>
                  <MicroPill
                    testID={`guide-source-offset-${guide.id}`}
                    label={i18n.t('sources.guides.offsetHours', {
                      hours: formatSignedOffsetHours(offsetHours),
                    })}
                    tone={offsetHours === 0 ? 'neutral' : 'accent'}
                  />
                  <MicroPill
                    testID={`guide-source-state-${guide.id}`}
                    label={i18n.t(guide.enabled ? 'player.stats.on' : 'player.stats.off')}
                    tone={guide.enabled ? 'success' : 'neutral'}
                  />
                </View>

                <View style={styles.rowActions}>
                  <CtaButton
                    testID={`guide-source-up-${guide.id}`}
                    variant="secondary"
                    label={i18n.t('sources.guides.priorityUp')}
                    disabled={busy || idx === 0}
                    focusable={!isTv}
                    focused={isGuideSlotFocused(guide.id, 'row-up')}
                    onPress={() => void handleReorder(idx, -1)}
                  />
                  <CtaButton
                    testID={`guide-source-down-${guide.id}`}
                    variant="secondary"
                    label={i18n.t('sources.guides.priorityDown')}
                    disabled={busy || idx === guides.length - 1}
                    focusable={!isTv}
                    focused={isGuideSlotFocused(guide.id, 'row-down')}
                    onPress={() => void handleReorder(idx, 1)}
                  />
                  <CtaButton
                    testID={`guide-source-offset-dec-${guide.id}`}
                    variant="secondary"
                    label="-1h"
                    disabled={busy || offsetHours <= MIN_EPG_OFFSET_HOURS}
                    focusable={!isTv}
                    focused={isGuideSlotFocused(guide.id, 'row-offset-dec')}
                    onPress={() => void handleStepOffset(guide, -1)}
                  />
                  <CtaButton
                    testID={`guide-source-offset-inc-${guide.id}`}
                    variant="secondary"
                    label="+1h"
                    disabled={busy || offsetHours >= MAX_EPG_OFFSET_HOURS}
                    focusable={!isTv}
                    focused={isGuideSlotFocused(guide.id, 'row-offset-inc')}
                    onPress={() => void handleStepOffset(guide, 1)}
                  />
                  <CtaButton
                    testID={`guide-source-toggle-${guide.id}`}
                    variant="secondary"
                    label={i18n.t(guide.enabled ? 'player.stats.off' : 'player.stats.on')}
                    disabled={busy}
                    focusable={!isTv}
                    focused={isGuideSlotFocused(guide.id, 'row-toggle')}
                    onPress={() => void handleToggleEnabled(guide)}
                  />
                  <CtaButton
                    testID={`guide-source-remove-${guide.id}`}
                    variant="secondary"
                    icon="trash"
                    label={i18n.t('sources.guides.remove')}
                    disabled={busy}
                    focusable={!isTv}
                    focused={isGuideSlotFocused(guide.id, 'row-remove')}
                    onPress={() => void handleRemove(guide.id)}
                  />
                </View>
              </Surface>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  topActions: { flexDirection: 'row', alignItems: 'center' },
  addCard: { padding: 14, gap: 10 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
  },
  offsetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
  },
  stepperGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  offsetValue: { minWidth: 44, textAlign: 'center', fontWeight: '700' },
  list: { gap: 10 },
  guideRow: { padding: 12, gap: 10 },
  guideHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex1: { flex: 1 },
  rowActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});

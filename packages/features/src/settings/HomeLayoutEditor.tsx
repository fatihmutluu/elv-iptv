import {
  DEFAULT_HOME_LAYOUT,
  type HomeLayoutSectionId,
  type HomeLayoutSectionPref,
  homeLayoutEquals,
  normalizeHomeLayout,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  Icon,
  IconButton,
  Surface,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppearanceFocusId } from './useTvSettingsNavigation';

/** Maps each customizable Home layout section id to its i18n label key. */
export const HOME_SECTION_LABEL_KEYS: Readonly<Record<HomeLayoutSectionId, MessageId>> = {
  continue: 'settings.homeSectionContinue',
  live: 'settings.homeSectionLive',
  mylist: 'settings.homeSectionMyList',
  movies: 'settings.homeSectionMovies',
  series: 'settings.homeSectionSeries',
  collections: 'settings.homeSectionCollections',
};

const WIDE_SECTIONS = new Set<HomeLayoutSectionId>(['continue', 'live']);

/** Moves the section at `index` one slot up or down, returning a new layout array. */
export function moveHomeLayoutSection(
  layout: readonly HomeLayoutSectionPref[],
  index: number,
  direction: 'up' | 'down',
): readonly HomeLayoutSectionPref[] {
  const normalized = normalizeHomeLayout(layout);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= normalized.length) return normalized;
  if (targetIndex < 0 || targetIndex >= normalized.length) return normalized;
  return reorderHomeLayoutSection(normalized, index, targetIndex);
}

/** Moves the section at `fromIndex` to `toIndex`, returning a new normalized layout array. */
export function reorderHomeLayoutSection(
  layout: readonly HomeLayoutSectionPref[],
  fromIndex: number,
  toIndex: number,
): readonly HomeLayoutSectionPref[] {
  const normalized = normalizeHomeLayout(layout);
  if (
    fromIndex < 0 ||
    fromIndex >= normalized.length ||
    toIndex < 0 ||
    toIndex >= normalized.length ||
    fromIndex === toIndex
  ) {
    return normalized;
  }
  const next = [...normalized];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return normalized;
  next.splice(toIndex, 0, moved);
  return normalizeHomeLayout(next);
}

/** Toggles the `visible` flag of section `id`, returning a new layout array. */
export function toggleHomeLayoutSection(
  layout: readonly HomeLayoutSectionPref[],
  id: HomeLayoutSectionId,
): readonly HomeLayoutSectionPref[] {
  const normalized = normalizeHomeLayout(layout);
  return normalizeHomeLayout(
    normalized.map((entry) => (entry.id === id ? { ...entry, visible: !entry.visible } : entry)),
  );
}

/** Props of {@link HomeLayoutEditor}. */
export interface HomeLayoutEditorProps {
  readonly layout: readonly HomeLayoutSectionPref[];
  readonly onChange: (next: readonly HomeLayoutSectionPref[]) => void;
  readonly focusedControlId?: AppearanceFocusId | null;
  readonly isTv?: boolean;
  readonly onLayoutBox?: (box: { readonly y: number; readonly height: number }) => void;
}

/**
 * Cinema Quietude Home screen layout editor (Wave P4): live miniature Home wireframe preview,
 * per-section show/hide toggles, Up/Down reorder buttons, desktop pointer drag-and-drop reorder,
 * and Reset default layout.
 */
export function HomeLayoutEditor({
  layout,
  onChange,
  focusedControlId = null,
  isTv = false,
  onLayoutBox,
}: HomeLayoutEditorProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const normalized = useMemo(() => normalizeHomeLayout(layout), [layout]);
  const visibleSections = useMemo(() => normalized.filter((s) => s.visible), [normalized]);
  const hiddenCount = normalized.length - visibleSections.length;
  const isCustomized = !homeLayoutEquals(normalized, DEFAULT_HOME_LAYOUT);

  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragTargetIdx, setDragTargetIdx] = useState<number | null>(null);
  const dragStartYRef = useRef(0);
  const dragFromRef = useRef<number | null>(null);
  const dragTargetRef = useRef<number | null>(null);
  const rowHeightRef = useRef(48);
  const layoutRef = useRef(normalized);
  layoutRef.current = normalized;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (Platform.OS !== 'web' || dragFromIdx === null) return undefined;
    const win = globalThis as unknown as {
      addEventListener?: (t: string, fn: (e: { clientY: number }) => void) => void;
      removeEventListener?: (t: string, fn: (e: { clientY: number }) => void) => void;
    };
    if (!win.addEventListener || !win.removeEventListener) return undefined;

    const handleMove = (e: { clientY: number }) => {
      const from = dragFromRef.current;
      if (from === null) return;
      const deltaRows = Math.round(
        (e.clientY - dragStartYRef.current) / Math.max(32, rowHeightRef.current),
      );
      const clamped = Math.max(0, Math.min(layoutRef.current.length - 1, from + deltaRows));
      dragTargetRef.current = clamped;
      setDragTargetIdx(clamped);
    };
    const finishDrag = (commit: boolean) => {
      const from = dragFromRef.current;
      const to = dragTargetRef.current;
      dragFromRef.current = null;
      dragTargetRef.current = null;
      setDragFromIdx(null);
      setDragTargetIdx(null);
      if (commit && from !== null && to !== null && from !== to) {
        onChangeRef.current(reorderHomeLayoutSection(layoutRef.current, from, to));
      }
    };
    const handleUp = () => finishDrag(true);
    const handleCancel = () => finishDrag(false);
    win.addEventListener('pointermove', handleMove);
    win.addEventListener('pointerup', handleUp);
    win.addEventListener('pointercancel', handleCancel);
    win.addEventListener('blur', handleCancel);
    return () => {
      win.removeEventListener?.('pointermove', handleMove);
      win.removeEventListener?.('pointerup', handleUp);
      win.removeEventListener?.('pointercancel', handleCancel);
      win.removeEventListener?.('blur', handleCancel);
    };
  }, [dragFromIdx]);

  const handleStartDrag = useCallback((index: number, clientY: number) => {
    dragStartYRef.current = clientY;
    dragFromRef.current = index;
    dragTargetRef.current = index;
    setDragFromIdx(index);
    setDragTargetIdx(index);
  }, []);

  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  return (
    <Surface
      testID="settings-section-home-layout"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.card}
      onLayout={
        onLayoutBox
          ? (e) => onLayoutBox({ y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height })
          : undefined
      }
    >
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('settings.homeLayoutTitle')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('settings.homeLayoutDesc')}
          </Text>
        </View>
        {isCustomized ? (
          <CtaButton
            testID="home-layout-reset"
            variant="secondary"
            label={i18n.t('settings.homeLayoutReset')}
            focused={focusedControlId === 'home-layout-reset'}
            focusable={!isTv}
            onPress={() => onChange(DEFAULT_HOME_LAYOUT)}
          />
        ) : null}
      </View>

      <View
        testID="home-layout-preview"
        style={[
          styles.previewBox,
          {
            backgroundColor: theme.colors.bgCanvas,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.card,
          },
        ]}
      >
        <View style={styles.previewHeader}>
          <Text style={[theme.typography.micro, { color: theme.colors.textSecondary }]}>
            {i18n.t('settings.homeLayoutPreview')}
          </Text>
          {hiddenCount > 0 ? (
            <Text
              testID="home-layout-hidden-count"
              style={[theme.typography.micro, { color: theme.colors.textSecondary }]}
            >
              {i18n.t('settings.homeLayoutHiddenCount', { count: hiddenCount })}
            </Text>
          ) : null}
        </View>
        <View
          testID="home-layout-preview-hero"
          style={[
            styles.previewHero,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.button,
            },
          ]}
        >
          <View style={[styles.previewHeroAccent, { backgroundColor: theme.colors.accent }]} />
        </View>
        <View style={styles.previewRows}>
          {visibleSections.map((section) => {
            const isWide = WIDE_SECTIONS.has(section.id);
            return (
              <View
                key={section.id}
                testID={`home-layout-preview-row-${section.id}`}
                style={styles.previewSection}
              >
                <Text
                  numberOfLines={1}
                  style={[theme.typography.micro, { color: theme.colors.textSecondary }]}
                >
                  {i18n.t(HOME_SECTION_LABEL_KEYS[section.id])}
                </Text>
                <View style={styles.previewCardsRow}>
                  {[0, 1, 2, 3].map((slot) => (
                    <View
                      key={slot}
                      style={[
                        isWide ? styles.previewWideCard : styles.previewPosterCard,
                        {
                          backgroundColor: theme.colors.bgSurface,
                          borderColor: theme.colors.surfaceBorder,
                        },
                      ]}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.list}>
        {normalized.map((section, index) => {
          const isDragging = dragFromIdx === index;
          const showDropBefore =
            dragFromIdx !== null && dragTargetIdx === index && dragTargetIdx < dragFromIdx;
          const showDropAfter =
            dragFromIdx !== null && dragTargetIdx === index && dragTargetIdx > dragFromIdx;
          const isFocused = focusedControlId === `home-layout-${section.id}`;
          const label = i18n.t(HOME_SECTION_LABEL_KEYS[section.id]);
          const webDragProps =
            Platform.OS === 'web'
              ? ({
                  onPointerDown: (e: { clientY?: number; preventDefault?: () => void }) => {
                    if (typeof e.clientY !== 'number') return;
                    e.preventDefault?.();
                    handleStartDrag(index, e.clientY);
                  },
                } as Record<string, unknown>)
              : {};

          return (
            <View
              key={section.id}
              onLayout={(e) => {
                if (e.nativeEvent.layout.height > 0)
                  rowHeightRef.current = e.nativeEvent.layout.height;
              }}
            >
              {showDropBefore ? (
                <View
                  testID={`home-layout-drop-before-${section.id}`}
                  style={[styles.dropLine, { backgroundColor: theme.colors.accent }]}
                />
              ) : null}
              <View
                testID={`home-layout-row-${section.id}`}
                style={[
                  styles.sectionRow,
                  transition,
                  {
                    backgroundColor: isFocused ? theme.colors.focusFill : theme.colors.bgElevated,
                    borderColor: isFocused ? theme.colors.accent : theme.colors.surfaceBorder,
                    borderRadius: theme.radius.button,
                    opacity: isDragging ? 0.55 : section.visible ? 1 : 0.65,
                  },
                ]}
              >
                <View
                  testID={`home-layout-drag-${section.id}`}
                  style={[styles.dragHandle, cursorPointer]}
                  {...webDragProps}
                >
                  <Icon name="dots" size={16} color={theme.colors.textSecondary} />
                </View>

                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.body,
                    styles.sectionLabel,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {label}
                </Text>

                <View style={styles.rowActions}>
                  <View style={styles.rotateUp}>
                    <IconButton
                      testID={`home-layout-up-${section.id}`}
                      icon="chevronDown"
                      accessibilityLabel={i18n.t('settings.homeLayoutMoveUp')}
                      tooltip={i18n.t('settings.homeLayoutMoveUp')}
                      size={32}
                      disabled={index === 0}
                      focusable={!isTv}
                      onPress={() => onChange(moveHomeLayoutSection(normalized, index, 'up'))}
                    />
                  </View>
                  <IconButton
                    testID={`home-layout-down-${section.id}`}
                    icon="chevronDown"
                    accessibilityLabel={i18n.t('settings.homeLayoutMoveDown')}
                    tooltip={i18n.t('settings.homeLayoutMoveDown')}
                    size={32}
                    disabled={index === normalized.length - 1}
                    focusable={!isTv}
                    onPress={() => onChange(moveHomeLayoutSection(normalized, index, 'down'))}
                  />
                  <Pressable
                    testID={`home-layout-toggle-${section.id}`}
                    accessibilityRole="switch"
                    accessibilityLabel={label}
                    accessibilityState={{ checked: section.visible }}
                    aria-checked={section.visible}
                    focusable={!isTv}
                    onPress={() => onChange(toggleHomeLayoutSection(normalized, section.id))}
                    style={[styles.switchWrap, cursorPointer]}
                  >
                    <View
                      style={[
                        styles.switchTrack,
                        {
                          backgroundColor: section.visible
                            ? theme.colors.accent
                            : theme.colors.bgSurface,
                          borderColor: section.visible
                            ? theme.colors.accent
                            : theme.colors.surfaceBorder,
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.switchThumb,
                          {
                            backgroundColor: theme.colors.textPrimary,
                            transform: [{ translateX: section.visible ? 16 : 2 }],
                          },
                        ]}
                      />
                    </View>
                  </Pressable>
                </View>
              </View>
              {showDropAfter ? (
                <View
                  testID={`home-layout-drop-after-${section.id}`}
                  style={[styles.dropLine, { backgroundColor: theme.colors.accent }]}
                />
              ) : null}
            </View>
          );
        })}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14 },
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: { flex: 1, minWidth: 200, gap: 2 },
  previewBox: { padding: 12, borderWidth: 1, gap: 8 },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  previewHero: {
    height: 26,
    borderWidth: 1,
    justifyContent: 'flex-end',
    padding: 5,
  },
  previewHeroAccent: { width: 34, height: 4, borderRadius: 2 },
  previewRows: { gap: 6 },
  previewSection: { gap: 3 },
  previewCardsRow: { flexDirection: 'row', gap: 6 },
  previewWideCard: { width: 42, height: 18, borderRadius: 3, borderWidth: 1 },
  previewPosterCard: { width: 22, height: 24, borderRadius: 3, borderWidth: 1 },
  list: { gap: 8 },
  dropLine: { height: 2, borderRadius: 1, marginVertical: 2 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    gap: 10,
  },
  dragHandle: { padding: 4, justifyContent: 'center', alignItems: 'center' },
  sectionLabel: { flex: 1 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rotateUp: { transform: [{ rotate: '180deg' }] },
  switchWrap: { padding: 4 },
  switchTrack: {
    width: 38,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    justifyContent: 'center',
  },
  switchThumb: { width: 16, height: 16, borderRadius: 8 },
});

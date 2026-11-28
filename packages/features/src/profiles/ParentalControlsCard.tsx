import {
  type BrowseKind,
  type CatalogService,
  type CategoryRow,
  parseCategoryId,
  type SourceRow,
  type UpdateParentalSettingsPatch,
} from '@elv/data';
import {
  CtaButton,
  FilterChip,
  Icon,
  MicroPill,
  Surface,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useParental } from '../shared';
import { isRelaxingParentalPatch } from '../shared/profile-context-helpers';

const AGE_RATING_OPTIONS: readonly (number | null)[] = [null, 7, 12, 14, 16, 18];
const UNLOCK_TIMEOUT_OPTIONS: readonly number[] = [5, 15, 30, 60, 0];

/** Props of {@link ParentalControlsCard}. */
export interface ParentalControlsCardProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly isActiveScope?: boolean;
}

interface LockableCategoryEntry {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly kind: BrowseKind;
  readonly row: CategoryRow;
}

function SwitchPill({ checked }: { readonly checked: boolean }): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.switchTrack,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: checked ? theme.colors.accent : theme.colors.bgCard,
          borderColor: checked ? theme.colors.accent : theme.colors.chipBorder,
        },
      ]}
    >
      <View
        style={[
          styles.switchThumb,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: checked ? theme.colors.accentContrast : theme.colors.textPrimary,
            alignSelf: checked ? 'flex-end' : 'flex-start',
          },
        ]}
      />
    </View>
  );
}

/**
 * Cinema Quietude v2 Settings -> Kids Mode card (`#31`, `#506`).
 * Renders strictly title, 1-line description, and master toggle while OFF; prompts PIN creation
 * on first enable; reveals PIN controls, keyword blocking, age limits, timeout, and category locks once ON.
 */
export function ParentalControlsCard({
  catalog,
  sources,
  isActiveScope = true,
}: ParentalControlsCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const parental = useParental();
  const {
    activeProfileId,
    profilesReady,
    parentalSettings,
    parentalLocks,
    hasParentalPin,
    hasGuardPin,
    guardPinProfileId,
    parentalUnlocked,
    parentalLoadError,
    lockParentalNow,
    updateParentalSettings,
    setParentalLock,
    retryParentalLoad,
    requestParentalUnlock,
    openPinDialog,
  } = parental;

  const isEnabled = parentalSettings.enabled;
  const needsPinGate = hasGuardPin && !parentalUnlocked;
  const effectiveGuardPinProfileId = guardPinProfileId ?? activeProfileId;

  const [categoryKind, setCategoryKind] = useState<BrowseKind>('live');
  const [categories, setCategories] = useState<readonly LockableCategoryEntry[]>([]);
  const [focusedToggle, setFocusedToggle] = useState<'enabled' | 'adult' | null>(null);
  const [focusedCatId, setFocusedCatId] = useState<string | null>(null);

  const readySources = useMemo(() => sources.filter((s) => !s.needsImport), [sources]);

  useEffect(() => {
    let cancelled = false;
    if (
      !isEnabled ||
      parentalLoadError ||
      readySources.length === 0 ||
      !profilesReady ||
      needsPinGate
    ) {
      setCategories([]);
      return undefined;
    }
    void Promise.all(
      readySources.map(async (source) => {
        const rows = await catalog
          .categories(source.id, categoryKind, {
            includeHidden: true,
            profileId: activeProfileId,
            parentalUnlocked: true,
          })
          .catch(() => [] as CategoryRow[]);
        return rows.map((row) => ({
          sourceId: source.id,
          sourceName: source.name,
          kind: categoryKind,
          row,
        }));
      }),
    ).then((nested) => {
      if (!cancelled) setCategories(nested.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeProfileId,
    catalog,
    categoryKind,
    isEnabled,
    needsPinGate,
    parentalLoadError,
    profilesReady,
    readySources,
  ]);

  const lockedCategoryKeys = useMemo(() => {
    const set = new Set<string>();
    for (const lock of parentalLocks) {
      if (lock.targetKind === 'category') {
        set.add(`${lock.sourceId}|${lock.itemKind}|${lock.targetKey}`);
      }
    }
    return set;
  }, [parentalLocks]);

  /** Gates restricted mutations behind PIN verification whenever a guard PIN is set and currently locked. */
  const runProtected = useCallback(
    (action: () => void) => {
      if (parentalLoadError) return;
      if (hasGuardPin && !parentalUnlocked) {
        requestParentalUnlock(action);
        return;
      }
      action();
    },
    [hasGuardPin, parentalLoadError, parentalUnlocked, requestParentalUnlock],
  );

  /** Always re-verifies the current guard PIN before relaxing or disabling any parental protection. */
  const runReverified = useCallback(
    (action: () => void) => {
      if (parentalLoadError) return;
      if (hasGuardPin) {
        openPinDialog({
          mode: 'verify',
          title: i18n.t('parental.reverifyTitle'),
          profileId: effectiveGuardPinProfileId,
          verifyOnly: true,
          onSuccess: action,
        });
        return;
      }
      action();
    },
    [effectiveGuardPinProfileId, hasGuardPin, i18n, openPinDialog, parentalLoadError],
  );

  const applySettingsPatch = useCallback(
    (patch: UpdateParentalSettingsPatch) => {
      if (parentalLoadError) return;
      const run = () => {
        void updateParentalSettings(patch);
      };
      if (isRelaxingParentalPatch(parentalSettings, patch)) {
        runReverified(run);
        return;
      }
      runProtected(run);
    },
    [parentalLoadError, parentalSettings, runProtected, runReverified, updateParentalSettings],
  );

  const handleToggleKidsMode = useCallback(() => {
    if (parentalLoadError) return;
    if (!isEnabled) {
      if (!hasGuardPin) {
        openPinDialog({
          mode: 'create',
          profileId: activeProfileId,
          onSuccess: () => {
            void updateParentalSettings({ enabled: true });
          },
        });
        return;
      }
      runProtected(() => {
        void updateParentalSettings({ enabled: true });
      });
      return;
    }
    runReverified(() => {
      void updateParentalSettings({ enabled: false });
    });
  }, [
    activeProfileId,
    hasGuardPin,
    isEnabled,
    openPinDialog,
    parentalLoadError,
    runProtected,
    runReverified,
    updateParentalSettings,
  ]);

  const kindTabs = useMemo<
    readonly { readonly id: BrowseKind; readonly label: string; readonly testID: string }[]
  >(
    () => [
      { id: 'live', label: i18n.t('nav.live'), testID: 'parental-cat-kind-live' },
      { id: 'movie', label: i18n.t('nav.movies'), testID: 'parental-cat-kind-movie' },
      { id: 'series', label: i18n.t('nav.series'), testID: 'parental-cat-kind-series' },
    ],
    [i18n],
  );

  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');
  const buildToggleStyle = (
    baseStyle: typeof styles.masterRow | typeof styles.toggleRow,
    focused: boolean,
    dimmed = false,
  ) => [
    baseStyle,
    cursorPointer,
    transition,
    {
      borderRadius: theme.radius.card,
      borderWidth: focused ? theme.focus.ringWidth : 1,
      borderColor: focused ? theme.colors.focusRingColor : 'transparent',
      backgroundColor: focused ? theme.colors.focusFill : 'transparent',
      ...(dimmed ? { opacity: 0.55 } : {}),
    },
  ];

  return (
    <Surface
      testID="parental-controls-card"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.card}
    >
      <Pressable
        testID="parental-toggle-enabled"
        disabled={parentalLoadError}
        accessibilityRole="switch"
        accessibilityLabel={i18n.t('parental.title')}
        accessibilityState={{ checked: isEnabled, disabled: parentalLoadError }}
        aria-checked={isEnabled}
        focusable={!parentalLoadError}
        hasTVPreferredFocus={isTv && isActiveScope && !parentalLoadError}
        onFocus={() => setFocusedToggle('enabled')}
        onBlur={() => setFocusedToggle((prev) => (prev === 'enabled' ? null : prev))}
        onPress={handleToggleKidsMode}
        style={(state) =>
          buildToggleStyle(
            styles.masterRow,
            focusedToggle === 'enabled' || Boolean(state.focused),
            parentalLoadError,
          )
        }
      >
        <View style={styles.headerText}>
          <View style={styles.titleLine}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('parental.title')}
            </Text>
            {isEnabled && hasGuardPin ? (
              <MicroPill
                testID="parental-status-badge"
                label={
                  parentalUnlocked
                    ? i18n.t('parental.unlockedBadge')
                    : i18n.t('parental.lockedBadge')
                }
                tone={parentalUnlocked ? 'accent' : 'neutral'}
              />
            ) : null}
          </View>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('parental.modeDescription')}
          </Text>
        </View>
        <SwitchPill checked={isEnabled} />
      </Pressable>

      {parentalLoadError ? (
        <View
          testID="parental-load-error"
          style={[
            styles.lockedCategoriesBox,
            {
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.bgCard,
              borderColor: theme.colors.liveColor,
            },
          ]}
        >
          <View style={styles.lockedCategoriesInfo}>
            <Icon name="warning" size={16} color={theme.colors.liveColor} />
            <Text
              style={[
                theme.typography.caption,
                styles.lockedCategoriesText,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t('parental.loadErrorMessage')}
            </Text>
          </View>
          <CtaButton
            testID="parental-retry-load"
            variant="primary"
            label={i18n.t('parental.retryLoad')}
            onPress={() => {
              void retryParentalLoad();
            }}
          />
        </View>
      ) : null}

      {isEnabled && !parentalLoadError ? (
        <>
          <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

          {/* PIN status and actions */}
          <View style={styles.rowHeader}>
            <View style={styles.rowText}>
              <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                {i18n.t('parental.pinTitle')}
              </Text>
              <Text
                testID="parental-pin-status"
                style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
              >
                {hasGuardPin ? i18n.t('parental.pinSet') : i18n.t('parental.pinNotSet')}
              </Text>
            </View>
            <View style={styles.buttonRow}>
              {hasGuardPin ? (
                parentalUnlocked ? (
                  <CtaButton
                    testID="parental-lock-now"
                    variant="secondary"
                    label={i18n.t('parental.lockNow')}
                    onPress={lockParentalNow}
                  />
                ) : (
                  <CtaButton
                    testID="parental-unlock-button"
                    variant="primary"
                    label={i18n.t('parental.unlockButton')}
                    onPress={() =>
                      openPinDialog({ mode: 'verify', profileId: effectiveGuardPinProfileId })
                    }
                  />
                )
              ) : null}
              {!hasParentalPin ? (
                <CtaButton
                  testID="parental-set-pin"
                  variant={hasGuardPin ? 'secondary' : 'primary'}
                  label={i18n.t('parental.setPin')}
                  onPress={() =>
                    runReverified(() =>
                      openPinDialog({ mode: 'create', profileId: activeProfileId }),
                    )
                  }
                />
              ) : (
                <>
                  <CtaButton
                    testID="parental-change-pin"
                    variant="secondary"
                    label={i18n.t('parental.changePin')}
                    onPress={() => openPinDialog({ mode: 'change', profileId: activeProfileId })}
                  />
                  <CtaButton
                    testID="parental-remove-pin"
                    variant="secondary"
                    label={i18n.t('parental.removePin')}
                    onPress={() => openPinDialog({ mode: 'remove', profileId: activeProfileId })}
                  />
                </>
              )}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

          {/* Block adult keywords toggle */}
          <Pressable
            testID="parental-toggle-adult-keywords"
            accessibilityRole="switch"
            accessibilityLabel={i18n.t('parental.adultKeywordsToggle')}
            accessibilityState={{ checked: parentalSettings.blockAdultKeywords }}
            aria-checked={parentalSettings.blockAdultKeywords}
            focusable
            onFocus={() => setFocusedToggle('adult')}
            onBlur={() => setFocusedToggle((prev) => (prev === 'adult' ? null : prev))}
            onPress={() =>
              applySettingsPatch({ blockAdultKeywords: !parentalSettings.blockAdultKeywords })
            }
            style={(state) =>
              buildToggleStyle(
                styles.toggleRow,
                focusedToggle === 'adult' || Boolean(state.focused),
              )
            }
          >
            <View style={styles.rowText}>
              <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                {i18n.t('parental.adultKeywordsToggle')}
              </Text>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('parental.adultKeywordsHint')}
              </Text>
            </View>
            <SwitchPill checked={parentalSettings.blockAdultKeywords} />
          </Pressable>

          <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

          {/* Max age rating */}
          <View style={styles.rowHeader}>
            <View style={styles.rowText}>
              <Text
                style={[
                  theme.typography.title,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {i18n.t('parental.maxAgeLabel')}
              </Text>
            </View>
            <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
              {AGE_RATING_OPTIONS.map((age) => (
                <FilterChip
                  key={age === null ? 'off' : String(age)}
                  testID={`parental-max-age-${age === null ? 'off' : String(age)}`}
                  label={
                    age === null
                      ? i18n.t('parental.maxAgeOff')
                      : i18n.t('parental.maxAgeOption', { age })
                  }
                  selected={parentalSettings.maxRatingAge === age}
                  onPress={() => {
                    if (parentalSettings.maxRatingAge === age) return;
                    applySettingsPatch({ maxRatingAge: age });
                  }}
                />
              ))}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

          {/* Unlock timeout */}
          <View style={styles.rowHeader}>
            <View style={styles.rowText}>
              <Text
                style={[
                  theme.typography.title,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {i18n.t('parental.unlockTimeoutLabel')}
              </Text>
            </View>
            <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
              {UNLOCK_TIMEOUT_OPTIONS.map((minutes) => (
                <FilterChip
                  key={String(minutes)}
                  testID={`parental-timeout-${minutes}`}
                  label={
                    minutes === 0
                      ? i18n.t('parental.timeoutSession')
                      : i18n.t('parental.timeoutMinutes', { minutes })
                  }
                  selected={parentalSettings.unlockTimeoutMin === minutes}
                  onPress={() => {
                    if (parentalSettings.unlockTimeoutMin === minutes) return;
                    applySettingsPatch({ unlockTimeoutMin: minutes });
                  }}
                />
              ))}
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

          {/* Category Locks */}
          <View style={styles.catSection}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('parental.lockedCategoriesTitle')}
            </Text>

            {needsPinGate ? (
              <View
                testID="parental-categories-locked"
                style={[
                  styles.lockedCategoriesBox,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: theme.colors.bgCard,
                    borderColor: theme.colors.surfaceBorder,
                  },
                ]}
              >
                <View style={styles.lockedCategoriesInfo}>
                  <Icon name="lock" size={16} color={theme.colors.accent} />
                  <Text
                    style={[
                      theme.typography.caption,
                      styles.lockedCategoriesText,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    {i18n.t('parental.lockedMessage')}
                  </Text>
                </View>
                <CtaButton
                  testID="parental-categories-unlock"
                  variant="primary"
                  label={i18n.t('parental.unlockButton')}
                  onPress={() =>
                    openPinDialog({ mode: 'verify', profileId: effectiveGuardPinProfileId })
                  }
                />
              </View>
            ) : (
              <>
                <View
                  testID="parental-cat-kind-bar"
                  style={[styles.chipRow, { gap: theme.spacing.xs }]}
                >
                  {kindTabs.map((tab) => (
                    <FilterChip
                      key={tab.id}
                      testID={tab.testID}
                      label={tab.label}
                      selected={categoryKind === tab.id}
                      onPress={() => setCategoryKind(tab.id)}
                    />
                  ))}
                </View>

                {categories.length === 0 ? (
                  <Text
                    testID="parental-categories-empty"
                    style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                  >
                    {i18n.t('parental.lockedCategoriesEmpty')}
                  </Text>
                ) : (
                  <View style={styles.catList}>
                    {categories.map((entry) => {
                      const targetKey = parseCategoryId(entry.row.id)?.providerId ?? entry.row.id;
                      const lockCompositeKey = `${entry.sourceId}|${entry.kind}|${targetKey}`;
                      const isLocked = lockedCategoryKeys.has(lockCompositeKey);
                      const rowKey = `${entry.sourceId}-${entry.row.id}`;
                      return (
                        <Pressable
                          key={rowKey}
                          testID={`parental-cat-lock-${entry.row.id}`}
                          accessibilityRole="switch"
                          accessibilityLabel={entry.row.name}
                          accessibilityState={{ checked: isLocked }}
                          aria-checked={isLocked}
                          focusable
                          onFocus={() => setFocusedCatId(rowKey)}
                          onBlur={() => setFocusedCatId((prev) => (prev === rowKey ? null : prev))}
                          onPress={() => {
                            const nextLocked = !isLocked;
                            const mutate = () => {
                              void setParentalLock(
                                {
                                  sourceId: entry.sourceId,
                                  targetKind: 'category',
                                  itemKind: entry.kind,
                                  targetKey,
                                },
                                nextLocked,
                              );
                            };
                            if (!nextLocked) runReverified(mutate);
                            else runProtected(mutate);
                          }}
                          style={(state) => {
                            const focused = focusedCatId === rowKey || Boolean(state.focused);
                            return [
                              styles.catRow,
                              cursorPointer,
                              transition,
                              {
                                borderRadius: theme.radius.card,
                                borderWidth: focused ? theme.focus.ringWidth : 1,
                                backgroundColor: focused
                                  ? theme.colors.focusFill
                                  : isLocked
                                    ? theme.colors.subtleHighlight
                                    : theme.colors.bgCard,
                                borderColor: focused
                                  ? theme.colors.focusRingColor
                                  : isLocked
                                    ? theme.colors.accent
                                    : theme.colors.surfaceBorder,
                              },
                            ];
                          }}
                        >
                          <View style={styles.catInfo}>
                            <Text
                              numberOfLines={1}
                              style={[theme.typography.body, { color: theme.colors.textPrimary }]}
                            >
                              {entry.row.name}
                            </Text>
                            {readySources.length > 1 ? (
                              <Text
                                numberOfLines={1}
                                style={[theme.typography.micro, { color: theme.colors.textMuted }]}
                              >
                                {entry.sourceName}
                              </Text>
                            ) : null}
                          </View>
                          <View style={styles.catStatus}>
                            {isLocked ? (
                              <Icon name="lock" size={14} color={theme.colors.accent} />
                            ) : null}
                            <Text
                              style={[
                                theme.typography.caption,
                                {
                                  color: isLocked
                                    ? theme.colors.accent
                                    : theme.colors.textSecondary,
                                },
                              ]}
                            >
                              {isLocked
                                ? i18n.t('parental.categoryLocked')
                                : i18n.t('parental.categoryUnlocked')}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </>
            )}
          </View>
        </>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14 },
  masterRow: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  headerText: { flex: 1, gap: 4 },
  titleLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  divider: { height: 1, width: '100%' },
  rowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 200, gap: 2 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  toggleRow: {
    minHeight: 46,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  switchTrack: { width: 38, height: 22, borderWidth: 1, padding: 2, justifyContent: 'center' },
  switchThumb: { width: 16, height: 16 },
  catSection: { gap: 10 },
  lockedCategoriesBox: {
    padding: 14,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  lockedCategoriesInfo: {
    flex: 1,
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lockedCategoriesText: { flex: 1 },
  catList: { gap: 6 },
  catRow: {
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  catInfo: { flex: 1, gap: 2 },
  catStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});

import {
  type BrowseKind,
  type CatalogService,
  type CategoryRow,
  parseCategoryId,
  type SourceRow,
} from '@elv/data';
import {
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  FilterChip,
  Icon,
  MicroPill,
  Surface,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useParental } from '../shared';

const AGE_RATING_OPTIONS: readonly (number | null)[] = [null, 7, 12, 14, 16, 18];
const UNLOCK_TIMEOUT_OPTIONS: readonly number[] = [5, 15, 30, 60, 0];

/** Props of {@link ParentalControlsCard}. */
export interface ParentalControlsCardProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
}

interface LockableCategoryEntry {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly kind: BrowseKind;
  readonly row: CategoryRow;
}

/**
 * Cinema Quietude v2 Parental Controls settings card (`#31`):
 * PIN lifecycle, session unlock/relock, master toggle, adult keyword blocking, max age rating,
 * unlock timeout, and source-aware category locks persisted across imports.
 */
export function ParentalControlsCard({
  catalog,
  sources,
}: ParentalControlsCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const parental = useParental();
  const {
    activeProfileId,
    parentalSettings,
    parentalLocks,
    hasParentalPin,
    parentalUnlocked,
    lockParentalNow,
    updateParentalSettings,
    setParentalLock,
    requestParentalUnlock,
    openPinDialog,
  } = parental;

  const [categoryKind, setCategoryKind] = useState<BrowseKind>('live');
  const [categories, setCategories] = useState<readonly LockableCategoryEntry[]>([]);

  const readySources = useMemo(() => sources.filter((s) => !s.needsImport), [sources]);

  useEffect(() => {
    let cancelled = false;
    if (readySources.length === 0) {
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
      if (!cancelled) {
        setCategories(nested.flat());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, catalog, categoryKind, readySources]);

  const lockedCategoryKeys = useMemo(() => {
    const set = new Set<string>();
    for (const lock of parentalLocks) {
      if (lock.targetKind === 'category') {
        set.add(`${lock.sourceId}|${lock.itemKind}|${lock.targetKey}`);
      }
    }
    return set;
  }, [parentalLocks]);

  /** Gates restricted mutations behind PIN verification whenever a PIN is set and currently locked. */
  const runProtected = useCallback(
    (action: () => void) => {
      if (hasParentalPin && !parentalUnlocked) {
        requestParentalUnlock(action);
        return;
      }
      action();
    },
    [hasParentalPin, parentalUnlocked, requestParentalUnlock],
  );

  const kindTabs = useMemo<readonly EditorialCategoryItem[]>(
    () => [
      { id: 'live', label: i18n.t('nav.live'), testID: 'parental-cat-kind-live' },
      { id: 'movie', label: i18n.t('nav.movies'), testID: 'parental-cat-kind-movie' },
      { id: 'series', label: i18n.t('nav.series'), testID: 'parental-cat-kind-series' },
    ],
    [i18n],
  );

  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <Surface
      testID="parental-controls-card"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.card}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {i18n.t('parental.title')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('parental.subtitle')}
          </Text>
        </View>
        {parentalSettings.enabled || hasParentalPin ? (
          <MicroPill
            testID="parental-status-badge"
            label={
              parentalUnlocked ? i18n.t('parental.unlockedBadge') : i18n.t('parental.lockedBadge')
            }
            tone={parentalUnlocked ? 'accent' : 'neutral'}
          />
        ) : null}
      </View>

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
            {hasParentalPin ? i18n.t('parental.pinSet') : i18n.t('parental.pinNotSet')}
          </Text>
        </View>
        <View style={styles.buttonRow}>
          {!hasParentalPin ? (
            <CtaButton
              testID="parental-set-pin"
              variant="primary"
              label={i18n.t('parental.setPin')}
              onPress={() => openPinDialog({ mode: 'create', profileId: activeProfileId })}
            />
          ) : (
            <>
              {parentalUnlocked ? (
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
                  onPress={() => openPinDialog({ mode: 'verify', profileId: activeProfileId })}
                />
              )}
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

      {/* Master enable toggle */}
      <Pressable
        testID="parental-toggle-enabled"
        accessibilityRole="switch"
        accessibilityLabel={i18n.t('parental.enabledToggle')}
        accessibilityState={{ checked: parentalSettings.enabled }}
        aria-checked={parentalSettings.enabled}
        onPress={() =>
          runProtected(() => {
            void updateParentalSettings({ enabled: !parentalSettings.enabled });
          })
        }
        style={[styles.toggleRow, cursorPointer, transition]}
      >
        <View style={styles.rowText}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('parental.enabledToggle')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('parental.enabledHint')}
          </Text>
        </View>
        <View
          style={[
            styles.switchTrack,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: parentalSettings.enabled ? theme.colors.accent : theme.colors.bgCard,
              borderColor: parentalSettings.enabled ? theme.colors.accent : theme.colors.chipBorder,
            },
          ]}
        >
          <View
            style={[
              styles.switchThumb,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: parentalSettings.enabled
                  ? theme.colors.accentContrast
                  : theme.colors.textPrimary,
                alignSelf: parentalSettings.enabled ? 'flex-end' : 'flex-start',
              },
            ]}
          />
        </View>
      </Pressable>

      <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

      {/* Block adult keywords toggle */}
      <Pressable
        testID="parental-toggle-adult-keywords"
        accessibilityRole="switch"
        accessibilityLabel={i18n.t('parental.adultKeywordsToggle')}
        accessibilityState={{ checked: parentalSettings.blockAdultKeywords }}
        aria-checked={parentalSettings.blockAdultKeywords}
        onPress={() =>
          runProtected(() => {
            void updateParentalSettings({
              blockAdultKeywords: !parentalSettings.blockAdultKeywords,
            });
          })
        }
        style={[styles.toggleRow, cursorPointer, transition]}
      >
        <View style={styles.rowText}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('parental.adultKeywordsToggle')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('parental.adultKeywordsHint')}
          </Text>
        </View>
        <View
          style={[
            styles.switchTrack,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: parentalSettings.blockAdultKeywords
                ? theme.colors.accent
                : theme.colors.bgCard,
              borderColor: parentalSettings.blockAdultKeywords
                ? theme.colors.accent
                : theme.colors.chipBorder,
            },
          ]}
        >
          <View
            style={[
              styles.switchThumb,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: parentalSettings.blockAdultKeywords
                  ? theme.colors.accentContrast
                  : theme.colors.textPrimary,
                alignSelf: parentalSettings.blockAdultKeywords ? 'flex-end' : 'flex-start',
              },
            ]}
          />
        </View>
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
          {AGE_RATING_OPTIONS.map((age) => {
            const label =
              age === null
                ? i18n.t('parental.maxAgeOff')
                : i18n.t('parental.maxAgeOption', { age });
            const key = age === null ? 'off' : String(age);
            return (
              <FilterChip
                key={key}
                testID={`parental-max-age-${key}`}
                label={label}
                selected={parentalSettings.maxRatingAge === age}
                onPress={() =>
                  runProtected(() => {
                    void updateParentalSettings({ maxRatingAge: age });
                  })
                }
              />
            );
          })}
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
          {UNLOCK_TIMEOUT_OPTIONS.map((minutes) => {
            const label =
              minutes === 0
                ? i18n.t('parental.timeoutSession')
                : i18n.t('parental.timeoutMinutes', { minutes });
            return (
              <FilterChip
                key={String(minutes)}
                testID={`parental-timeout-${minutes}`}
                label={label}
                selected={parentalSettings.unlockTimeoutMin === minutes}
                onPress={() =>
                  runProtected(() => {
                    void updateParentalSettings({ unlockTimeoutMin: minutes });
                  })
                }
              />
            );
          })}
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

      {/* Category Locks */}
      <View style={styles.catSection}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {i18n.t('parental.lockedCategoriesTitle')}
        </Text>

        <EditorialCategoryBar
          testID="parental-cat-kind-bar"
          items={kindTabs}
          activeId={categoryKind}
          onSelect={(id) => setCategoryKind(id as BrowseKind)}
          isTv={false}
          padX={0}
        />

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
              return (
                <Pressable
                  key={`${entry.sourceId}-${entry.row.id}`}
                  testID={`parental-cat-lock-${entry.row.id}`}
                  accessibilityRole="switch"
                  accessibilityLabel={entry.row.name}
                  accessibilityState={{ checked: isLocked }}
                  aria-checked={isLocked}
                  onPress={() => {
                    const toggle = () => {
                      void setParentalLock(
                        {
                          sourceId: entry.sourceId,
                          targetKind: 'category',
                          itemKind: entry.kind,
                          targetKey,
                        },
                        !isLocked,
                      );
                    };
                    if (isLocked) {
                      runProtected(toggle);
                    } else {
                      toggle();
                    }
                  }}
                  style={[
                    styles.catRow,
                    cursorPointer,
                    transition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: isLocked
                        ? theme.colors.subtleHighlight
                        : theme.colors.bgCard,
                      borderColor: isLocked ? theme.colors.accent : theme.colors.surfaceBorder,
                    },
                  ]}
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
                    {isLocked ? <Icon name="lock" size={14} color={theme.colors.accent} /> : null}
                    <Text
                      style={[
                        theme.typography.caption,
                        { color: isLocked ? theme.colors.accent : theme.colors.textSecondary },
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
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: { flex: 1, gap: 4 },
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  switchTrack: { width: 38, height: 22, borderWidth: 1, padding: 2, justifyContent: 'center' },
  switchThumb: { width: 16, height: 16 },
  catSection: { gap: 10 },
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

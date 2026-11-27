import type { CatalogService, ElvPersonLibraryItem } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
  ArtworkImage,
  HorizontalRailScroll,
  hexToRgba,
  Icon,
  MicroPill,
  PosterCard,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { formatVodMeta } from './catalog-helpers';
import { type DetailTarget, detailTargetFromItem } from './detail-target';
import { applyElvCardPresentation } from './elv-presentation';

/** Actor or director identity passed into {@link PersonLibraryModal}. */
export interface PersonLibraryModalPerson {
  readonly personId?: string | null;
  readonly name: string;
  readonly portraitUrl?: string | null;
}

/**
 * Splits comma- or ampersand-separated co-director credits (e.g. `"Joel Coen, Ethan Coen"`,
 * `"Lana Wachowski & Lilly Wachowski"`) into deduplicated individual director names (`#512`, `#352`).
 */
export function splitDirectorNames(director: string | null | undefined): readonly string[] {
  if (typeof director !== 'string') return [];
  const raw = director.trim();
  if (raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/\s*(?:,|&)\s*/)) {
    const cleaned = part.trim();
    if (cleaned.length === 0) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/** Props of {@link PersonLibraryModal}. */
export interface PersonLibraryModalProps {
  readonly visible: boolean;
  readonly person: PersonLibraryModalPerson | null;
  readonly catalog: Partial<Pick<CatalogService, 'listElvPersonLibraryItems'>>;
  readonly elvPreferences?: ElvModePreferences;
  /** When `true`, renders in flex-flow cleanly outside native desktop child HWNDs (`#352`). */
  readonly docked?: boolean;
  readonly onSelectItem: (target: DetailTarget) => void;
  readonly onClose: () => void;
}

function formatRoleBadge(entry: ElvPersonLibraryItem, t: ReturnType<typeof useI18n>['t']): string {
  const character = entry.character?.trim() ?? '';
  if (entry.role === 'director') return t('person.role.director');
  if (entry.role === 'both') {
    const base = `${t('person.role.director')} · ${t('person.role.cast')}`;
    return character.length > 0 ? `${base} (${character})` : base;
  }
  const castLabel = t('person.role.cast');
  return character.length > 0 ? `${castLabel} · ${character}` : castLabel;
}

function PersonLibraryTvBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="person-library-tv-anchor" hasTVPreferredFocus />;
}

/**
 * Shared clickable Actor / Director library overlay (`#512`, `#352`) showing every matching movie
 * and series in the user's active IPTV library. Lives in `shared/` so both `detail/` and `player/`
 * open it cleanly without violating `no-feature-to-feature`, uses zero RN `<Modal>`, and supports
 * 10-ft TV D-pad, Desktop Escape, Mobile touch, and docked HWND-safe Desktop layout.
 */
export const PersonLibraryModal = memo(function PersonLibraryModalInner({
  visible,
  person,
  catalog,
  elvPreferences,
  docked = false,
  onSelectItem,
  onClose,
}: PersonLibraryModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const isPortrait = viewport.orientation === 'portrait';

  const [items, setItems] = useState<readonly ElvPersonLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  /** TV focus slot: `-1` = Close button, `0..items.length-1` = item cards. */
  const [tvFocusIndex, setTvFocusIndex] = useState(-1);
  const railScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const cardWidth = docked ? 116 : isTv ? 156 : isPortrait ? 112 : 142;

  useEffect(() => {
    if (!visible || !isTv || docked || tvFocusIndex < 0) return;
    const step = cardWidth + theme.spacing.md;
    const x = Math.max(0, tvFocusIndex * step - theme.spacing.lg);
    railScrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
  }, [
    cardWidth,
    docked,
    isTv,
    theme.reduceMotion,
    theme.spacing.lg,
    theme.spacing.md,
    tvFocusIndex,
    visible,
  ]);

  const effectiveElvPrefs = useMemo<ElvModePreferences>(
    () =>
      elvPreferences ?? {
        ...DEFAULT_ELV_MODE_PREFERENCES,
        elvModeEnabled: true,
        elvEnrichMetadata: true,
      },
    [elvPreferences],
  );

  const hasPerson = person !== null;
  const personId = person?.personId?.trim() || undefined;
  const personName = person?.name.trim() ?? '';

  useEffect(() => {
    if (!visible || !hasPerson || personName === '') {
      setItems([]);
      setLoading(false);
      setTvFocusIndex(-1);
      return undefined;
    }
    const listFn = catalog.listElvPersonLibraryItems;
    if (listFn === undefined) {
      setItems([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setTvFocusIndex(-1);
    const query = personId !== undefined ? { personId, name: personName } : { name: personName };
    void listFn(query)
      .then((res) => {
        if (!cancelled) {
          setItems(res);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalog.listElvPersonLibraryItems, hasPerson, personId, personName, visible]);

  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return undefined;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, fn: (ev: unknown) => void) => void;
          removeEventListener?: (type: string, fn: (ev: unknown) => void) => void;
        };
      }
    ).window;
    if (typeof win?.addEventListener !== 'function') return undefined;
    const onKeyDown = (ev: unknown) => {
      const key = (ev as { key?: string } | null)?.key;
      if (key === 'Escape') onClose();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [onClose, visible]);

  const presentedEntries = useMemo(
    () =>
      items.map((entry) => ({
        entry,
        item: applyElvCardPresentation(
          entry.item,
          entry.enrichment,
          effectiveElvPrefs,
          i18n.locale,
        ),
      })),
    [effectiveElvPrefs, i18n.locale, items],
  );

  const handleSelectEntry = useCallback(
    (entryIndex: number) => {
      const pair = presentedEntries[entryIndex];
      if (!pair) return;
      const target = detailTargetFromItem(pair.item);
      if (target) {
        onClose();
        onSelectItem(target);
      }
    },
    [onClose, onSelectItem, presentedEntries],
  );

  const presentedCountRef = useRef(presentedEntries.length);
  presentedCountRef.current = presentedEntries.length;
  const tvFocusRef = useRef(tvFocusIndex);
  tvFocusRef.current = tvFocusIndex;

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      if (event.key === 'back') {
        onClose();
        return true;
      }
      const count = presentedCountRef.current;
      const cur = tvFocusRef.current;
      if (event.key === 'right' || event.key === 'down') {
        if (count === 0) return true;
        const next = cur < 0 ? 0 : Math.min(count - 1, cur + 1);
        setTvFocusIndex(next);
        return true;
      }
      if (event.key === 'left' || event.key === 'up') {
        if (cur <= 0) {
          setTvFocusIndex(-1);
        } else {
          setTvFocusIndex(cur - 1);
        }
        return true;
      }
      if (event.key === 'select') {
        if (cur < 0) onClose();
        else handleSelectEntry(cur);
        return true;
      }
      return true;
    },
    [handleSelectEntry, onClose],
  );

  if (!visible || person === null) return null;

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const closeFocused = isTv && tvFocusIndex === -1;

  const panelContent = (
    <View
      testID="person-library-modal"
      accessibilityViewIsModal
      style={[
        docked ? styles.dockedPanel : styles.modalPanel,
        !docked && webBackdropBlur(20),
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.surfaceBorder,
          borderRadius: docked ? 0 : theme.radius.modal,
          ...(docked
            ? { borderLeftWidth: 1 }
            : {
                maxWidth: isTv ? 960 : 760,
                maxHeight: Math.max(360, Math.round(viewport.height * 0.82)),
              }),
        },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        <ArtworkImage
          testID="person-library-avatar"
          uri={person.portraitUrl ?? null}
          label={personName}
          aspectRatio={1}
          maxDecodePx={160}
          borderRadius={theme.radius.pill}
          style={styles.avatar}
        />
        <View style={styles.headerMeta}>
          <Text
            testID="person-library-name"
            numberOfLines={1}
            style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
          >
            {personName}
          </Text>
          <Text
            testID="person-library-count"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textSecondary, marginTop: 2 }]}
          >
            {i18n.t('person.alsoInLibrary', { count: presentedEntries.length })}
          </Text>
        </View>
        <Pressable
          testID="person-library-close"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('person.close')}
          focusable={!isTv}
          onPress={onClose}
          style={({ pressed }) => [
            styles.closeButton,
            cursor,
            transition,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: closeFocused ? theme.colors.focusFill : theme.colors.actionGlassBg,
              borderColor: closeFocused
                ? theme.colors.focusRingColor
                : theme.colors.actionGlassBorder,
              borderWidth: closeFocused ? theme.focus.ringWidth : 1,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Icon name="close" size={18} color={theme.colors.textPrimary} />
        </Pressable>
      </View>

      {loading ? (
        <View testID="person-library-loading" style={styles.centerState}>
          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
        </View>
      ) : presentedEntries.length === 0 ? (
        <View testID="person-library-empty" style={styles.centerState}>
          <Text
            style={[
              theme.typography.body,
              { color: theme.colors.textSecondary, textAlign: 'center' },
            ]}
          >
            {i18n.t('person.emptyLibrary')}
          </Text>
        </View>
      ) : docked ? (
        <ScrollView
          testID="person-library-docked-list"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.dockedGrid}
        >
          {presentedEntries.map(({ entry, item }, idx) => {
            const meta = formatVodMeta(item.year, item.rating);
            return (
              <View key={item.key} style={styles.cardColumn}>
                <PosterCard
                  testID={`person-library-item-${idx}`}
                  title={item.name}
                  {...(meta !== undefined ? { meta } : {})}
                  imageUri={item.logo}
                  width={cardWidth}
                  maxDecodePx={280}
                  focusable={!isTv}
                  focused={isTv && tvFocusIndex === idx}
                  onPress={() => handleSelectEntry(idx)}
                />
                <View style={styles.rolePillWrap}>
                  <MicroPill
                    testID={`person-library-role-${idx}`}
                    label={formatRoleBadge(entry, i18n.t)}
                  />
                </View>
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <HorizontalRailScroll
          scrollRef={railScrollRef}
          testID="person-library-strip"
          isTv={isTv}
          showArrows={!isTv}
          contentContainerStyle={[
            styles.stripContent,
            {
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: isTv ? 18 : 14,
              gap: theme.spacing.md,
            },
          ]}
        >
          {presentedEntries.map(({ entry, item }, idx) => {
            const meta = formatVodMeta(item.year, item.rating);
            return (
              <View key={item.key} style={[styles.cardColumn, { width: cardWidth }]}>
                <PosterCard
                  testID={`person-library-item-${idx}`}
                  title={item.name}
                  {...(meta !== undefined ? { meta } : {})}
                  imageUri={item.logo}
                  width={cardWidth}
                  maxDecodePx={320}
                  focusable={!isTv}
                  focused={isTv && tvFocusIndex === idx}
                  onPress={() => handleSelectEntry(idx)}
                />
                <View style={styles.rolePillWrap}>
                  <MicroPill
                    testID={`person-library-role-${idx}`}
                    label={formatRoleBadge(entry, i18n.t)}
                  />
                </View>
              </View>
            );
          })}
        </HorizontalRailScroll>
      )}
    </View>
  );

  if (docked) {
    return (
      <View testID="person-library-docked-host" style={styles.dockedHost}>
        {isTv ? <PersonLibraryTvBridge onEvent={handleTvKey} /> : null}
        {panelContent}
      </View>
    );
  }

  return (
    <View testID="person-library-overlay" style={styles.overlayRoot}>
      {isTv ? <PersonLibraryTvBridge onEvent={handleTvKey} /> : null}
      <Pressable
        testID="person-library-backdrop"
        accessibilityRole="button"
        accessibilityLabel={i18n.t('person.close')}
        focusable={false}
        onPress={onClose}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: hexToRgba(theme.colors.bgCanvas, 0.78) },
        ]}
      />
      <View pointerEvents="box-none" style={styles.modalCenter}>
        {panelContent}
      </View>
    </View>
  );
});

PersonLibraryModal.displayName = 'PersonLibraryModal';

const styles = StyleSheet.create({
  overlayRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 60,
  },
  modalCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalPanel: {
    width: '100%',
    borderWidth: 1,
    overflow: 'hidden',
  },
  dockedHost: {
    width: 340,
    flexShrink: 0,
    height: '100%',
  },
  dockedPanel: {
    flex: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    flexShrink: 0,
  },
  headerMeta: {
    flex: 1,
    minWidth: 0,
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  centerState: {
    paddingHorizontal: 24,
    paddingVertical: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripContent: {
    alignItems: 'flex-start',
  },
  dockedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    padding: 16,
  },
  cardColumn: {
    alignItems: 'flex-start',
    gap: 6,
  },
  rolePillWrap: {
    maxWidth: '100%',
  },
});

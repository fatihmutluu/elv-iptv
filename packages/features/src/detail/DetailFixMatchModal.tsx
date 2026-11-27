import type {
  CatalogService,
  ElvItemEnrichment,
  ElvMediaType,
  ElvSearchCandidate,
} from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  ArtworkImage,
  CtaButton,
  hexToRgba,
  Icon,
  TABULAR_NUMS_STYLE,
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
  TextInput,
  View,
} from 'react-native';

/** Props of {@link DetailFixMatchModal}. */
export interface DetailFixMatchModalProps {
  readonly visible: boolean;
  readonly itemKey: string;
  readonly sourceId: string;
  readonly mediaType: ElvMediaType;
  readonly initialQuery: string;
  readonly catalog: Partial<Pick<CatalogService, 'searchElvMatchCandidates' | 'applyElvFixMatch'>>;
  readonly onApplied: (enrichment: ElvItemEnrichment) => void;
  readonly onClose: () => void;
}

type FixMatchTvZone = 'input' | 'search' | 'candidates';

const CANDIDATE_ROW_ESTIMATE_HEIGHT = 88;

function FixMatchTvBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="detail-fix-match-tv-anchor" hasTVPreferredFocus />;
}

/**
 * Cinema Quietude Fix IMDb Match modal (`#512`): searches `/v1/elv/search` candidates and locks
 * `manual_lock = 1` via `catalog.applyElvFixMatch`, immediately refreshing Detail without RN `<Modal>`.
 */
export const DetailFixMatchModal = memo(function DetailFixMatchModalInner({
  visible,
  itemKey,
  sourceId,
  mediaType,
  initialQuery,
  catalog,
  onApplied,
  onClose,
}: DetailFixMatchModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const [query, setQuery] = useState(initialQuery);
  const [candidates, setCandidates] = useState<readonly ElvSearchCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [applyingImdbId, setApplyingImdbId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [tvZone, setTvZone] = useState<FixMatchTvZone>('candidates');
  const [tvIndex, setTvIndex] = useState(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const resultsScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const openSessionRef = useRef(0);
  const isOpenRef = useRef(visible);
  const applyingRef = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  const runSearch = useCallback(
    (rawQuery: string) => {
      const cleaned = rawQuery.trim();
      if (cleaned.length === 0 || catalog.searchElvMatchCandidates === undefined) {
        setCandidates([]);
        setTvZone('input');
        setHasSearched(true);
        return;
      }
      searchAbortRef.current?.abort();
      const ac = new AbortController();
      searchAbortRef.current = ac;
      setSearching(true);
      setErrorMessage(null);
      setHasSearched(true);
      void catalog
        .searchElvMatchCandidates(cleaned, mediaType, { signal: ac.signal })
        .then((res) => {
          if (ac.signal.aborted || !isOpenRef.current) return;
          setCandidates(res);
          setTvIndex(0);
          setTvZone(res.length > 0 ? 'candidates' : 'input');
          setSearching(false);
        })
        .catch(() => {
          if (ac.signal.aborted || !isOpenRef.current) return;
          setCandidates([]);
          setTvZone('input');
          setSearching(false);
          setErrorMessage(i18n.t('detail.fixMatch.error'));
        });
    },
    [catalog, i18n, mediaType],
  );

  useEffect(() => {
    if (!visible) {
      isOpenRef.current = false;
      openSessionRef.current += 1;
      applyingRef.current = false;
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      return undefined;
    }
    isOpenRef.current = true;
    openSessionRef.current += 1;
    applyingRef.current = false;
    setQuery(initialQuery);
    setErrorMessage(null);
    setApplyingImdbId(null);
    runSearch(initialQuery);
    return () => {
      isOpenRef.current = false;
      openSessionRef.current += 1;
      applyingRef.current = false;
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    };
  }, [initialQuery, runSearch, visible]);

  useEffect(() => {
    if (!visible || !isTv || tvZone !== 'candidates' || candidates.length === 0) return;
    const y = Math.max(0, (tvIndex - 1) * CANDIDATE_ROW_ESTIMATE_HEIGHT);
    resultsScrollRef.current?.scrollTo({ y, animated: !theme.reduceMotion });
  }, [candidates.length, isTv, theme.reduceMotion, tvIndex, tvZone, visible]);

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
      if (key === 'Escape') onCloseRef.current();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [visible]);

  const handleSelectCandidate = useCallback(
    (candidate: ElvSearchCandidate) => {
      if (applyingRef.current || catalog.applyElvFixMatch === undefined) return;
      const session = openSessionRef.current;
      applyingRef.current = true;
      setApplyingImdbId(candidate.imdbId);
      setErrorMessage(null);
      void catalog
        .applyElvFixMatch({
          itemKey,
          sourceId,
          mediaType,
          imdbId: candidate.imdbId,
          lang: i18n.locale,
        })
        .then((updated) => {
          if (!isOpenRef.current || openSessionRef.current !== session) return;
          applyingRef.current = false;
          setApplyingImdbId(null);
          if (updated === null) {
            setErrorMessage(i18n.t('detail.fixMatch.error'));
            return;
          }
          onAppliedRef.current(updated);
          onCloseRef.current();
        })
        .catch(() => {
          if (!isOpenRef.current || openSessionRef.current !== session) return;
          applyingRef.current = false;
          setApplyingImdbId(null);
          setErrorMessage(i18n.t('detail.fixMatch.error'));
        });
    },
    [catalog, i18n, itemKey, mediaType, sourceId],
  );

  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const tvZoneRef = useRef(tvZone);
  tvZoneRef.current = tvZone;
  const tvIndexRef = useRef(tvIndex);
  tvIndexRef.current = tvIndex;

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      if (event.key === 'back') {
        onCloseRef.current();
        return true;
      }
      const list = candidatesRef.current;
      const zone = tvZoneRef.current;
      if (event.key === 'right') {
        if (zone === 'input') setTvZone('search');
        return true;
      }
      if (event.key === 'left') {
        if (zone === 'search') setTvZone('input');
        return true;
      }
      if (event.key === 'down') {
        if (zone === 'input' || zone === 'search') {
          if (list.length > 0) {
            setTvZone('candidates');
            setTvIndex(0);
          } else if (zone === 'input') {
            setTvZone('search');
          }
        } else if (list.length > 0) {
          setTvIndex((idx) => Math.min(list.length - 1, idx + 1));
        }
        return true;
      }
      if (event.key === 'up') {
        if (zone === 'candidates') {
          if (tvIndexRef.current <= 0) setTvZone('input');
          else setTvIndex((idx) => Math.max(0, idx - 1));
        } else if (zone === 'search') {
          setTvZone('input');
        }
        return true;
      }
      if (event.key === 'select') {
        if (zone === 'input') {
          inputRef.current?.focus();
        } else if (zone === 'search') {
          runSearch(queryRef.current);
        } else {
          const picked = list[tvIndexRef.current];
          if (picked) handleSelectCandidate(picked);
        }
        return true;
      }
      return true;
    },
    [handleSelectCandidate, runSearch],
  );

  if (!visible) return null;

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  return (
    <View testID="detail-fix-match-modal" accessibilityViewIsModal style={styles.overlayRoot}>
      {isTv ? <FixMatchTvBridge onEvent={handleTvKey} /> : null}
      <Pressable
        testID="detail-fix-match-backdrop"
        accessibilityRole="button"
        accessibilityLabel={i18n.t('person.close')}
        focusable={false}
        onPress={onClose}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: hexToRgba(theme.colors.bgCanvas, 0.8) },
        ]}
      />
      <View pointerEvents="box-none" style={styles.center}>
        <View
          style={[
            styles.dialog,
            webBackdropBlur(20),
            {
              maxHeight: Math.max(380, Math.round(viewport.height * 0.82)),
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.modal,
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
            <View style={styles.headerText}>
              <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
                {i18n.t('detail.fixMatch.title')}
              </Text>
              <Text
                style={[
                  theme.typography.caption,
                  { color: theme.colors.textSecondary, marginTop: 2 },
                ]}
              >
                {i18n.t('detail.fixMatch.subtitle')}
              </Text>
            </View>
            <Pressable
              testID="detail-fix-match-close"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('person.close')}
              focusable={!isTv}
              onPress={onClose}
              style={[
                styles.closeBtn,
                cursor,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.actionGlassBg,
                  borderColor: theme.colors.actionGlassBorder,
                },
              ]}
            >
              <Icon name="close" size={18} color={theme.colors.textPrimary} />
            </Pressable>
          </View>

          <View style={styles.searchRow}>
            <TextInput
              ref={inputRef}
              testID="detail-fix-match-input"
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => runSearch(query)}
              placeholder={i18n.t('detail.fixMatch.placeholder')}
              placeholderTextColor={theme.colors.textMuted}
              returnKeyType="search"
              style={[
                styles.input,
                theme.typography.body,
                {
                  color: theme.colors.textPrimary,
                  backgroundColor:
                    isTv && tvZone === 'input' ? theme.colors.focusFill : theme.colors.bgSurface,
                  borderColor:
                    isTv && tvZone === 'input'
                      ? theme.colors.focusRingColor
                      : theme.colors.surfaceBorder,
                  borderWidth: isTv && tvZone === 'input' ? theme.focus.ringWidth : 1,
                  borderRadius: theme.radius.button,
                },
              ]}
            />
            <CtaButton
              testID="detail-fix-match-search"
              variant="primary"
              label={i18n.t('detail.fixMatch.search')}
              focusable={!isTv}
              focused={isTv && tvZone === 'search'}
              onPress={() => runSearch(query)}
            />
          </View>

          {errorMessage !== null ? (
            <Text
              testID="detail-fix-match-error"
              style={[
                theme.typography.caption,
                { color: theme.colors.liveColor, paddingHorizontal: 18, paddingBottom: 8 },
              ]}
            >
              {errorMessage}
            </Text>
          ) : null}

          {searching ? (
            <View testID="detail-fix-match-loading" style={styles.stateBox}>
              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('detail.fixMatch.searching')}
              </Text>
            </View>
          ) : candidates.length === 0 && hasSearched ? (
            <View testID="detail-fix-match-empty" style={styles.stateBox}>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                {i18n.t('detail.fixMatch.noResults')}
              </Text>
            </View>
          ) : (
            <ScrollView
              ref={resultsScrollRef}
              testID="detail-fix-match-results"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.resultsList}
            >
              {candidates.map((candidate, idx) => {
                const isApplying = applyingImdbId === candidate.imdbId;
                const focused = isTv && tvZone === 'candidates' && tvIndex === idx;
                return (
                  <Pressable
                    key={candidate.imdbId}
                    testID={`detail-fix-match-candidate-${idx}`}
                    accessibilityRole="button"
                    accessibilityLabel={
                      candidate.year !== null
                        ? `${candidate.title} (${candidate.year})`
                        : candidate.title
                    }
                    disabled={applyingImdbId !== null}
                    focusable={!isTv}
                    onPress={() => handleSelectCandidate(candidate)}
                    style={({ pressed }) => [
                      styles.candidateRow,
                      cursor,
                      transition,
                      {
                        borderRadius: theme.radius.button,
                        backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
                        borderColor: focused
                          ? theme.colors.focusRingColor
                          : theme.colors.surfaceBorder,
                        borderWidth: focused ? theme.focus.ringWidth : 1,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <ArtworkImage
                      uri={candidate.posterUrl}
                      label={candidate.title}
                      aspectRatio={2 / 3}
                      maxDecodePx={120}
                      borderRadius={theme.radius.button}
                      style={styles.posterThumb}
                    />
                    <View style={styles.candidateMeta}>
                      <Text
                        numberOfLines={1}
                        style={[
                          theme.typography.title,
                          { color: theme.colors.textPrimary, fontWeight: '600' },
                        ]}
                      >
                        {candidate.title}
                      </Text>
                      <View style={styles.candidateSubRow}>
                        {candidate.year !== null ? (
                          <Text
                            style={[
                              theme.typography.caption,
                              TABULAR_NUMS_STYLE,
                              { color: theme.colors.textSecondary },
                            ]}
                          >
                            {String(candidate.year)}
                          </Text>
                        ) : null}
                        <Text
                          style={[
                            theme.typography.micro,
                            TABULAR_NUMS_STYLE,
                            { color: theme.colors.textMuted },
                          ]}
                        >
                          {candidate.imdbId}
                        </Text>
                      </View>
                      {candidate.stars ? (
                        <Text
                          numberOfLines={1}
                          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                        >
                          {candidate.stars}
                        </Text>
                      ) : null}
                    </View>
                    {isApplying ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : (
                      <Icon name="check" size={16} color={theme.colors.textSecondary} />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </View>
  );
});

DetailFixMatchModal.displayName = 'DetailFixMatchModal';

const styles = StyleSheet.create({
  overlayRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 62,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  dialog: {
    width: '100%',
    maxWidth: 580,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  input: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  stateBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 28,
  },
  resultsList: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 8,
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
  },
  posterThumb: {
    width: 40,
    height: 60,
    flexShrink: 0,
  },
  candidateMeta: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  candidateSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});

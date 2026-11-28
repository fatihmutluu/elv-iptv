import type { RatingValue } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import {
  CtaButton,
  Icon,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { computeHeroHeight } from '../shared';
import type { DetailTechnicalMeta } from '../shared/detail-target';
import { DetailHeroBackdrop, DetailHeroPosterCard } from './DetailHeroBackdrop';
import { DetailSynopsisBlock, DetailVersionDropdown } from './DetailHeroExtras';
import type { DetailVersionOption } from './detail-data-helpers';
import {
  buildTechnicalBadges,
  detailProgressRatio,
  type PrimaryPlayAction,
  SYNOPSIS_EXPAND_THRESHOLD,
} from './detail-model';
import { formatCompactVotes } from './detail-trailer-utils';

/** Focusable interactive slot identifiers inside {@link DetailHero}. */
export type DetailHeroFocusSlot =
  | 'back'
  | 'mylist'
  | 'like'
  | 'dislike'
  | 'watched'
  | 'download'
  | 'trailer'
  | 'play'
  | 'preplay-version'
  | 'synopsis';

/** Visual state for the movie offline download icon button in {@link DetailHero}. */
export interface DetailHeroDownloadState {
  readonly icon: 'download' | 'pause' | 'check';
  readonly active: boolean;
  readonly label: string;
}

/** Props of {@link DetailHero}. */
export interface DetailHeroProps {
  readonly kind: 'movie' | 'series';
  readonly title: string;
  readonly backdropUri: string | null;
  readonly posterUri?: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly votes?: number | null;
  readonly runtimeMin?: number | null;
  readonly plot: string | null;
  readonly genres?: readonly string[];
  readonly downloadState?: DetailHeroDownloadState;
  readonly onPressDownload?: () => void;
  readonly onPressTrailer?: () => void;
  readonly technicalMeta?: DetailTechnicalMeta;
  readonly seasonsCount: number;
  readonly inMyList: boolean;
  readonly userRating?: RatingValue | null;
  readonly watched: boolean;
  readonly primaryAction: PrimaryPlayAction;
  readonly versions?: readonly DetailVersionOption[];
  readonly activeVersionKey?: string;
  readonly activeVersionLabel?: string;
  readonly versionMenuOpen?: boolean;
  readonly versionMenuIndex?: number;
  readonly onToggleVersionMenu?: () => void;
  readonly onCloseVersionMenu?: () => void;
  readonly onSelectVersion?: (key: string) => void;
  readonly synopsisExpanded?: boolean;
  readonly onToggleSynopsis?: () => void;
  readonly onBack: () => void;
  readonly onPlayPrimary: () => void;
  readonly onToggleMyList: () => void;
  readonly onToggleRating?: (next: RatingValue) => void;
  readonly onToggleWatched: () => void;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly topClearance: number;
  readonly padX: number;
  readonly focusedSlot: DetailHeroFocusSlot | null;
}

function resolvePlayLabel(action: PrimaryPlayAction, t: AppI18n['t']): string {
  if (action.kind === 'movie') {
    return action.resume ? t('detail.resumeMovie') : t('detail.playMovie');
  }
  if (action.kind === 'episode') {
    const vars = { season: action.season, episode: action.episodeNumber };
    return action.resume ? t('detail.resumeEpisode', vars) : t('detail.playEpisode', vars);
  }
  return t('detail.playMovie');
}

function DetailHeroInner({
  kind,
  title,
  backdropUri,
  posterUri = null,
  year,
  rating,
  votes = null,
  runtimeMin = null,
  plot,
  genres,
  downloadState,
  onPressDownload,
  onPressTrailer,
  technicalMeta,
  seasonsCount,
  inMyList,
  userRating = null,
  watched,
  primaryAction,
  versions,
  activeVersionKey,
  activeVersionLabel,
  versionMenuOpen = false,
  versionMenuIndex = 0,
  onToggleVersionMenu,
  onCloseVersionMenu,
  onSelectVersion,
  synopsisExpanded = false,
  onToggleSynopsis,
  onBack,
  onPlayPrimary,
  onToggleMyList,
  onToggleRating,
  onToggleWatched,
  isTv,
  isPortrait,
  topClearance,
  padX,
  focusedSlot,
}: DetailHeroProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const heroHeight = computeHeroHeight(
    viewport.height,
    isPortrait,
    isTv,
    viewport.formFactor === 'desktop',
  );

  const playLabel = resolvePlayLabel(primaryAction, i18n.t);
  const resumeRatio =
    primaryAction.kind !== 'pending' && primaryAction.resume && primaryAction.durationMs > 0
      ? detailProgressRatio(primaryAction.positionMs, primaryAction.durationMs)
      : undefined;
  const trimmedPlot = plot?.trim() ?? '';
  const synopsis = trimmedPlot.length > 0 ? trimmedPlot : i18n.t('detail.noSynopsis');
  const canExpandSynopsis =
    onToggleSynopsis !== undefined && trimmedPlot.length >= SYNOPSIS_EXPAND_THRESHOLD;
  const technicalBadges = buildTechnicalBadges(technicalMeta);
  const trimmedBackdrop = backdropUri?.trim() || null;
  const trimmedPoster = posterUri?.trim() || null;
  const isPortraitFallback = trimmedBackdrop === null && trimmedPoster !== null;
  const backFocused = isTv && focusedSlot === 'back';
  const synopsisFocused = isTv && focusedSlot === 'synopsis';
  const versionFocused = focusedSlot === 'preplay-version';
  const backLabel = i18n.t('detail.back');
  const glassBlur = webBackdropBlur(12);
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const cursor = webCursorPointer();

  return (
    <View
      testID="detail-hero"
      style={[
        styles.container,
        {
          minHeight: heroHeight,
          paddingTop: topClearance,
          paddingHorizontal: padX,
          paddingBottom: theme.spacing.lg,
          backgroundColor: theme.colors.bgSurface,
        },
      ]}
    >
      <DetailHeroBackdrop
        title={title}
        backdropUri={trimmedBackdrop}
        posterUri={trimmedPoster}
        isPortraitFallback={isPortraitFallback}
      />

      <View style={styles.foreground}>
        <Pressable
          testID="detail-back"
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          focusable={!isTv}
          onPress={onBack}
          style={({ pressed }) => [
            styles.backButton,
            glassBlur,
            transition,
            cursor,
            {
              minWidth: 40,
              minHeight: 40,
              borderRadius: theme.radius.pill,
              backgroundColor: backFocused ? theme.colors.focusFill : theme.colors.actionGlassBg,
              borderColor: theme.colors.actionGlassBorder,
              opacity: pressed ? 0.85 : 1,
              transform: [
                {
                  scale: pressed
                    ? theme.reduceMotion
                      ? 1
                      : 0.98
                    : backFocused
                      ? theme.focus.buttonScale
                      : 1,
                },
              ],
            },
          ]}
        >
          <Icon name="back" size={18} color={theme.colors.textPrimary} />
          <Text
            style={[
              theme.typography.caption,
              { color: theme.colors.textPrimary, fontWeight: '600' },
            ]}
          >
            {backLabel}
          </Text>
          {backFocused ? (
            <View
              pointerEvents="none"
              testID="detail-back-focus-ring"
              style={[
                styles.backFocusRing,
                {
                  borderRadius: theme.radius.pill,
                  borderWidth: theme.focus.ringWidth,
                  borderColor: theme.colors.focusRingColor,
                },
              ]}
            />
          ) : null}
        </Pressable>

        <View
          style={[
            styles.spacer,
            isPortraitFallback && isPortrait ? { minHeight: theme.spacing.md } : undefined,
          ]}
        />

        {isPortraitFallback && isPortrait && trimmedPoster !== null ? (
          <View style={{ marginBottom: theme.spacing.sm }}>
            <DetailHeroPosterCard
              posterUri={trimmedPoster}
              title={title}
              isPortrait={isPortrait}
              isTv={isTv}
            />
          </View>
        ) : null}

        <Text
          testID="detail-title"
          numberOfLines={2}
          style={[
            isPortrait ? theme.typography.h1 : theme.typography.display,
            { color: theme.colors.textPrimary, marginBottom: theme.spacing.md },
          ]}
        >
          {title}
        </Text>

        <View
          testID="detail-hero-bottom"
          style={[
            styles.heroBottom,
            {
              flexDirection: isPortrait ? 'column' : 'row',
              alignItems: isPortrait ? 'stretch' : 'flex-start',
              gap: isPortrait ? theme.spacing.md : theme.spacing.lg,
            },
          ]}
        >
          <View
            testID="detail-hero-actions"
            style={[styles.actionsCol, { width: isPortrait ? '100%' : 230, gap: theme.spacing.sm }]}
          >
            <View testID="detail-hero-icon-row" style={[styles.iconRow, { gap: theme.spacing.sm }]}>
              <IconButton
                testID="detail-mylist"
                icon={inMyList ? 'check' : 'plus'}
                active={inMyList}
                accessibilityLabel={inMyList ? i18n.t('home.inMyList') : i18n.t('home.addToList')}
                focusable={!isTv}
                focused={isTv && focusedSlot === 'mylist'}
                onPress={onToggleMyList}
              />
              {onToggleRating !== undefined ? (
                <>
                  <IconButton
                    testID="detail-like"
                    icon={userRating === 'like' ? 'likeFilled' : 'like'}
                    active={userRating === 'like'}
                    accessibilityLabel={
                      userRating === 'like' ? i18n.t('rating.clearLike') : i18n.t('rating.like')
                    }
                    focusable={!isTv}
                    focused={isTv && focusedSlot === 'like'}
                    onPress={() => onToggleRating('like')}
                  />
                  <IconButton
                    testID="detail-dislike"
                    icon={userRating === 'dislike' ? 'dislikeFilled' : 'dislike'}
                    active={userRating === 'dislike'}
                    accessibilityLabel={
                      userRating === 'dislike'
                        ? i18n.t('rating.clearDislike')
                        : i18n.t('rating.dislike')
                    }
                    focusable={!isTv}
                    focused={isTv && focusedSlot === 'dislike'}
                    onPress={() => onToggleRating('dislike')}
                  />
                </>
              ) : null}
              <IconButton
                testID="detail-watched"
                icon="check"
                active={watched}
                accessibilityLabel={
                  kind === 'series'
                    ? i18n.t('detail.scopePicker.watchedAction')
                    : watched
                      ? i18n.t('home.markUnwatched')
                      : i18n.t('home.markWatched')
                }
                focusable={!isTv}
                focused={isTv && focusedSlot === 'watched'}
                onPress={onToggleWatched}
              />
              {downloadState !== undefined && onPressDownload !== undefined ? (
                <IconButton
                  testID="detail-download"
                  icon={downloadState.icon}
                  active={downloadState.active}
                  accessibilityLabel={downloadState.label}
                  focusable={!isTv}
                  focused={isTv && focusedSlot === 'download'}
                  onPress={onPressDownload}
                />
              ) : null}
              {onPressTrailer !== undefined ? (
                <IconButton
                  testID="detail-trailer"
                  icon="film"
                  accessibilityLabel={i18n.t('detail.action.trailer')}
                  focusable={!isTv}
                  focused={isTv && focusedSlot === 'trailer'}
                  onPress={onPressTrailer}
                />
              ) : null}
            </View>

            <View style={styles.ctaWrap}>
              <CtaButton
                testID="detail-play"
                variant="primary"
                icon="play"
                label={playLabel}
                focusable={!isTv}
                focused={isTv && focusedSlot === 'play'}
                onPress={onPlayPrimary}
                style={styles.playCta}
              />
              {resumeRatio !== undefined ? (
                <View
                  pointerEvents="none"
                  testID="detail-play-progress"
                  style={[
                    styles.progressTrack,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: theme.colors.actionGlassHoverBg,
                    },
                  ]}
                >
                  <View
                    testID="detail-play-progress-fill"
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.round(resumeRatio * 1000) / 10}%`,
                        backgroundColor: theme.colors.accent,
                      },
                    ]}
                  />
                </View>
              ) : null}
            </View>
          </View>

          <View
            testID="detail-hero-meta"
            style={[styles.metaCol, !isPortrait ? styles.metaColFlex : undefined]}
          >
            <View style={[styles.metaRow, { gap: theme.spacing.sm }]}>
              {rating !== null && Number.isFinite(rating) ? (
                <Text
                  testID="detail-rating"
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.successColor, fontWeight: '700' },
                  ]}
                >
                  {`★ ${rating.toFixed(1)}`}
                </Text>
              ) : null}
              {(() => {
                const formattedVotes = formatCompactVotes(votes);
                return formattedVotes !== null ? (
                  <Text
                    testID="detail-votes"
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {i18n.t('detail.votesCount', { count: formattedVotes })}
                  </Text>
                ) : null;
              })()}
              {year !== null && Number.isFinite(year) ? (
                <Text
                  testID="detail-year"
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {String(year)}
                </Text>
              ) : null}
              {runtimeMin !== null && Number.isFinite(runtimeMin) && runtimeMin > 0 ? (
                <Text
                  testID="detail-runtime"
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {i18n.t('detail.runtimeMin', { minutes: Math.round(runtimeMin) })}
                </Text>
              ) : null}
              {kind === 'series' ? (
                <MicroPill label={i18n.t('home.kind.series')} testID="detail-kind-pill" />
              ) : null}
              {kind === 'series' && seasonsCount > 0 ? (
                <Text
                  testID="detail-seasons-count"
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {i18n.t('detail.seasonsCount', { count: seasonsCount })}
                </Text>
              ) : null}
              {watched ? (
                <MicroPill
                  label={i18n.t('home.watchedBadge')}
                  tone="success"
                  testID="detail-watched-badge"
                />
              ) : null}
              {genres && genres.length > 0 ? (
                <Text
                  testID="detail-genres"
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                >
                  {genres.join(' · ')}
                </Text>
              ) : null}
              {technicalBadges.map((badge) => (
                <MicroPill
                  key={badge.key}
                  label={badge.label}
                  testID={`detail-tech-badge-${badge.key}`}
                />
              ))}
            </View>

            <DetailSynopsisBlock
              synopsis={synopsis}
              canExpand={canExpandSynopsis}
              expanded={synopsisExpanded}
              isTv={isTv}
              focused={synopsisFocused}
              {...(onToggleSynopsis !== undefined ? { onToggle: onToggleSynopsis } : {})}
            />

            {versions !== undefined &&
            versions.length > 1 &&
            activeVersionKey !== undefined &&
            activeVersionLabel !== undefined &&
            onToggleVersionMenu !== undefined &&
            onCloseVersionMenu !== undefined &&
            onSelectVersion !== undefined ? (
              <DetailVersionDropdown
                versions={versions}
                activeVersionKey={activeVersionKey}
                activeVersionLabel={activeVersionLabel}
                open={versionMenuOpen}
                isTv={isTv}
                focused={versionFocused}
                tvHighlightedIndex={versionMenuIndex}
                onToggleOpen={onToggleVersionMenu}
                onClose={onCloseVersionMenu}
                onSelectVersion={onSelectVersion}
              />
            ) : null}
          </View>

          {isPortraitFallback && !isPortrait && trimmedPoster !== null ? (
            <DetailHeroPosterCard
              posterUri={trimmedPoster}
              title={title}
              isPortrait={isPortrait}
              isTv={isTv}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Full-bleed Cinema Quietude 2-column Detail Hero (`UI_UX_PHILOSOPHY.md` §1 & §3).
 * Pairs circular frosted action icons and a full-width primary Play/Resume CTA on the left
 * (`230px` Landscape) with clean metadata and synopsis on the right, stacking smoothly on Portrait.
 */
export const DetailHero = memo(DetailHeroInner);
DetailHero.displayName = 'DetailHero';

const styles = StyleSheet.create({
  container: { position: 'relative', zIndex: 10 },
  foreground: { position: 'relative', zIndex: 2, flex: 1, justifyContent: 'space-between' },
  backButton: {
    position: 'relative',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
  },
  backFocusRing: { position: 'absolute', top: -4, bottom: -4, left: -4, right: -4 },
  spacer: { minHeight: 52, flexGrow: 1 },
  heroBottom: { width: '100%' },
  actionsCol: { flexShrink: 0 },
  iconRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  ctaWrap: { width: '100%' },
  playCta: { width: '100%', alignSelf: 'stretch' },
  progressTrack: { height: 3, width: '100%', overflow: 'hidden', marginTop: 6 },
  progressFill: { height: '100%' },
  metaCol: { minWidth: 0 },
  metaColFlex: { flex: 1 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});

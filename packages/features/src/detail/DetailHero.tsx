import type { AppI18n } from '@elv/i18n';
import {
  ArtworkImage,
  CtaButton,
  Icon,
  IconButton,
  MicroPill,
  Scrim,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DetailTechnicalMeta } from '../shared/detail-target';
import { DetailPrePlayControls, DetailSynopsisBlock } from './DetailHeroExtras';
import {
  buildTechnicalBadges,
  detailProgressRatio,
  type PrimaryPlayAction,
  SYNOPSIS_EXPAND_THRESHOLD,
} from './detail-model';

/** Focusable interactive slot identifiers inside {@link DetailHero}. */
export type DetailHeroFocusSlot =
  | 'back'
  | 'mylist'
  | 'watched'
  | 'play'
  | 'preplay-version'
  | 'preplay-audio'
  | 'preplay-subtitles'
  | 'synopsis';

/** Props of {@link DetailHero}. */
export interface DetailHeroProps {
  readonly kind: 'movie' | 'series';
  readonly title: string;
  readonly backdropUri: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly plot: string | null;
  readonly genres?: readonly string[];
  readonly technicalMeta?: DetailTechnicalMeta;
  readonly seasonsCount: number;
  readonly inMyList: boolean;
  readonly watched: boolean;
  readonly primaryAction: PrimaryPlayAction;
  readonly audioLang?: string;
  readonly subtitleLang?: string;
  readonly versionLabel?: string;
  readonly onCycleVersion?: () => void;
  readonly onCycleAudio?: () => void;
  readonly onCycleSubtitles?: () => void;
  readonly synopsisExpanded?: boolean;
  readonly onToggleSynopsis?: () => void;
  readonly onBack: () => void;
  readonly onPlayPrimary: () => void;
  readonly onToggleMyList: () => void;
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
  year,
  rating,
  plot,
  genres,
  technicalMeta,
  seasonsCount,
  inMyList,
  watched,
  primaryAction,
  audioLang = '',
  subtitleLang = '',
  versionLabel,
  onCycleVersion,
  onCycleAudio,
  onCycleSubtitles,
  synopsisExpanded = false,
  onToggleSynopsis,
  onBack,
  onPlayPrimary,
  onToggleMyList,
  onToggleWatched,
  isTv,
  isPortrait,
  topClearance,
  padX,
  focusedSlot,
}: DetailHeroProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

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
  const kindLabel = i18n.t(kind === 'movie' ? 'home.kind.movie' : 'home.kind.series');
  const backFocused = isTv && focusedSlot === 'back';
  const synopsisFocused = isTv && focusedSlot === 'synopsis';
  const prePlayFocused =
    focusedSlot === 'preplay-version' ||
    focusedSlot === 'preplay-audio' ||
    focusedSlot === 'preplay-subtitles'
      ? focusedSlot
      : null;
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
          minHeight: isPortrait ? 360 : 400,
          paddingTop: topClearance,
          paddingHorizontal: padX,
          paddingBottom: theme.spacing.lg,
          backgroundColor: theme.colors.bgSurface,
        },
      ]}
    >
      <ArtworkImage
        testID="detail-hero-backdrop"
        uri={backdropUri}
        label={title}
        maxDecodePx={960}
        borderRadius={0}
        decorative
        style={StyleSheet.absoluteFill}
      />
      <Scrim direction="bottom" intensity="strong" testID="detail-hero-scrim-bottom" />
      <Scrim direction="left" intensity="strong" testID="detail-hero-scrim-left" />

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

        <View style={styles.spacer} />

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
            <View style={[styles.iconRow, { gap: theme.spacing.sm }]}>
              <IconButton
                testID="detail-mylist"
                icon={inMyList ? 'check' : 'plus'}
                active={inMyList}
                accessibilityLabel={inMyList ? i18n.t('home.inMyList') : i18n.t('home.addToList')}
                focusable={!isTv}
                focused={isTv && focusedSlot === 'mylist'}
                onPress={onToggleMyList}
              />
              {kind === 'movie' ? (
                <IconButton
                  testID="detail-watched"
                  icon="check"
                  active={watched}
                  accessibilityLabel={
                    watched ? i18n.t('home.markUnwatched') : i18n.t('home.markWatched')
                  }
                  focusable={!isTv}
                  focused={isTv && focusedSlot === 'watched'}
                  onPress={onToggleWatched}
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
              <MicroPill label={kindLabel} testID="detail-kind-pill" />
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
              {kind === 'movie' && watched ? (
                <MicroPill
                  label={i18n.t('home.watchedBadge')}
                  tone="success"
                  testID="detail-watched-badge"
                />
              ) : null}
              {genres && genres.length > 0 ? (
                <Text
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

            {onCycleAudio && onCycleSubtitles ? (
              <DetailPrePlayControls
                audioLang={audioLang}
                subtitleLang={subtitleLang}
                {...(versionLabel !== undefined && onCycleVersion !== undefined
                  ? { versionLabel, onCycleVersion }
                  : {})}
                onCycleAudio={onCycleAudio}
                onCycleSubtitles={onCycleSubtitles}
                isTv={isTv}
                focusedControl={prePlayFocused}
              />
            ) : null}
          </View>
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
  container: { position: 'relative', overflow: 'hidden' },
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
  iconRow: { flexDirection: 'row', alignItems: 'center' },
  ctaWrap: { width: '100%' },
  playCta: { width: '100%', alignSelf: 'stretch' },
  progressTrack: { height: 3, width: '100%', overflow: 'hidden', marginTop: 6 },
  progressFill: { height: '100%' },
  metaCol: { minWidth: 0 },
  metaColFlex: { flex: 1 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});

import type { UserItemKind } from '@elv/data';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { HomeHeroBackdrop } from './HomeHeroBackdrop';
import { formatRemainingMinutes, type HomeHeroSlide } from './home-model';

/** Focusable interactive slot identifiers inside {@link HomeHero}. */
export type HomeHeroActionId = 'play' | 'details' | 'mylist' | 'watched' | `dot-${number}`;

/** Returns the ordered TV-focusable action ids for the active hero slide and slide count. */
export function buildHeroActionIds(
  slide: HomeHeroSlide | undefined,
  slideCount: number,
  hasDetails = false,
): HomeHeroActionId[] {
  if (!slide) return [];
  const actions: HomeHeroActionId[] = ['play'];
  if (hasDetails && (slide.kind === 'movie' || slide.kind === 'series')) {
    actions.push('details');
  }
  actions.push('mylist');
  if (slide.kind !== 'live') actions.push('watched');
  if (slideCount > 1) {
    for (let i = 0; i < slideCount; i++) actions.push(`dot-${i}`);
  }
  return actions;
}

/** Props of {@link HomeHero}. */
export interface HomeHeroProps {
  readonly slides: readonly HomeHeroSlide[];
  readonly activeIndex: number;
  readonly onSelectIndex: (index: number) => void;
  readonly inMyList: boolean;
  readonly onPlaySlide: (slide: HomeHeroSlide) => void;
  readonly onOpenDetails?: (slide: HomeHeroSlide) => void;
  readonly onToggleMyList: (slide: HomeHeroSlide) => void;
  readonly onToggleWatched: (slide: HomeHeroSlide) => void;
  readonly onHoverChange?: (hovered: boolean) => void;
  readonly onFocusChange?: (focused: boolean) => void;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly isPortrait: boolean;
  readonly topClearance: number;
  readonly minHeight: number;
  readonly padX: number;
  readonly focusedAction: HomeHeroActionId | null;
}

const KIND_MESSAGE_ID: Readonly<Record<UserItemKind, MessageId>> = {
  live: 'home.kind.live',
  movie: 'home.kind.movie',
  series: 'home.kind.series',
  episode: 'home.kind.episode',
};

/**
 * Full-bleed edge-to-edge Cinema Quietude Hero Spotlight (`UI_UX_PHILOSOPHY.md` §1 & §3).
 * Routes backdrop art through `ArtworkImage` (`maxDecodePx={960}`), layers strong bottom + left
 * dynamic scrims, leaves safe top clearance for the overlay `AdaptiveNavShell`, and exposes
 * primary Play/Resume CTA, live My List toggle, VOD Watched toggle, and carousel dots.
 */
export function HomeHero({
  slides,
  activeIndex,
  onSelectIndex,
  inMyList,
  onPlaySlide,
  onOpenDetails,
  onToggleMyList,
  onToggleWatched,
  onHoverChange,
  onFocusChange,
  isTv,
  isTouch,
  isPortrait,
  topClearance,
  minHeight,
  padX,
  focusedAction,
}: HomeHeroProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();

  const safeIndex = slides.length > 0 ? Math.min(Math.max(0, activeIndex), slides.length - 1) : 0;
  const slide = slides[safeIndex];
  const handleHoverIn = useCallback(() => onHoverChange?.(true), [onHoverChange]);
  const handleHoverOut = useCallback(() => onHoverChange?.(false), [onHoverChange]);
  const handleFocus = useCallback(() => onFocusChange?.(true), [onFocusChange]);
  const handleBlur = useCallback(
    (event?: unknown) => {
      const ev = event as
        | { currentTarget?: { contains?: (node: unknown) => boolean }; relatedTarget?: unknown }
        | undefined;
      if (
        ev?.relatedTarget != null &&
        typeof ev.currentTarget?.contains === 'function' &&
        ev.currentTarget.contains(ev.relatedTarget)
      ) {
        return;
      }
      onFocusChange?.(false);
    },
    [onFocusChange],
  );

  if (slide === undefined) return null;

  const remMin = slide.isContinueWatching
    ? formatRemainingMinutes(slide.positionMs, slide.durationMs)
    : null;
  const kindLabel = i18n.t(KIND_MESSAGE_ID[slide.kind]);
  const statusText = slide.isContinueWatching
    ? remMin !== null
      ? `${i18n.t('home.continueWatching')} · ${i18n.t('home.remainingMin', { minutes: remMin })}`
      : i18n.t('home.continueWatching')
    : `${i18n.t('home.featuredTag')} · ${kindLabel}`;

  const playLabel =
    slide.isContinueWatching && !slide.watched ? i18n.t('home.resume') : i18n.t('home.watchNow');
  const canOpenDetails =
    onOpenDetails !== undefined && (slide.kind === 'movie' || slide.kind === 'series');
  const canToggleWatched = slide.kind !== 'live';
  const dotTransition = webTransition(theme, 'width, background-color, border-color');
  const cursor = webCursorPointer();

  return (
    <Pressable
      testID="home-hero"
      accessible={false}
      focusable={false}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onFocus={handleFocus}
      onBlur={handleBlur}
      style={[
        styles.container,
        {
          minHeight,
          paddingTop: topClearance,
          paddingHorizontal: padX,
          paddingBottom: isPortrait ? theme.spacing.sm : theme.spacing.md,
          backgroundColor: theme.colors.bgSurface,
        },
      ]}
    >
      <HomeHeroBackdrop slideKey={slide.itemKey} uri={slide.backdropUri} title={slide.title} />

      <View style={styles.content}>
        <View style={styles.statusRow}>
          <View
            testID="home-hero-status-bar"
            style={[styles.statusBar, { backgroundColor: theme.colors.accent }]}
          />
          <Text
            testID="home-hero-status"
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textPrimary, fontWeight: '600' },
            ]}
          >
            {statusText}
          </Text>
        </View>

        <Text
          testID="home-hero-title"
          numberOfLines={2}
          style={[
            isPortrait ? theme.typography.h1 : theme.typography.display,
            { color: theme.colors.textPrimary, marginTop: theme.spacing.xs },
          ]}
        >
          {slide.title}
        </Text>

        <View style={[styles.metaRow, { marginTop: theme.spacing.xs, gap: theme.spacing.xs }]}>
          {slide.rating !== null ? (
            <Text
              testID="home-hero-rating"
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.successColor, fontWeight: '700' },
              ]}
            >
              {`★ ${slide.rating.toFixed(1)}`}
            </Text>
          ) : null}
          {slide.year !== null ? (
            <Text
              testID="home-hero-year"
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textSecondary },
              ]}
            >
              {String(slide.year)}
            </Text>
          ) : null}
          {slide.subtitle ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {slide.subtitle}
            </Text>
          ) : null}
          {slide.genres && slide.genres.length > 0 ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {slide.genres.join(' · ')}
            </Text>
          ) : null}
          <MicroPill label={kindLabel} testID="home-hero-kind-pill" />
          {slide.watched ? (
            <MicroPill
              label={i18n.t('home.watchedBadge')}
              tone="success"
              testID="home-hero-watched-badge"
            />
          ) : null}
        </View>

        {slide.overview ? (
          <Text
            testID="home-hero-overview"
            numberOfLines={isPortrait ? 2 : 3}
            style={[
              theme.typography.body,
              styles.overview,
              { color: theme.colors.textSecondary, marginTop: theme.spacing.xs },
            ]}
          >
            {slide.overview}
          </Text>
        ) : null}

        <View style={[styles.bottomBar, { marginTop: theme.spacing.sm, gap: theme.spacing.sm }]}>
          <View style={[styles.actionsRow, { gap: theme.spacing.sm }]}>
            <CtaButton
              testID="home-hero-play"
              variant="primary"
              icon="play"
              label={playLabel}
              focusable={!isTv}
              focused={isTv && focusedAction === 'play'}
              onPress={() => onPlaySlide(slide)}
            />
            {canOpenDetails ? (
              <CtaButton
                testID="home-hero-details"
                variant="secondary"
                icon="info"
                label={i18n.t('home.details')}
                focusable={!isTv}
                focused={isTv && focusedAction === 'details'}
                onPress={() => onOpenDetails(slide)}
              />
            ) : null}
            <IconButton
              testID="home-hero-mylist"
              icon={inMyList ? 'check' : 'plus'}
              active={inMyList}
              accessibilityLabel={inMyList ? i18n.t('home.inMyList') : i18n.t('home.addToList')}
              focusable={!isTv}
              focused={isTv && focusedAction === 'mylist'}
              onPress={() => onToggleMyList(slide)}
            />
            {canToggleWatched ? (
              <IconButton
                testID="home-hero-watched"
                icon="check"
                active={slide.watched}
                accessibilityLabel={
                  slide.watched ? i18n.t('home.markUnwatched') : i18n.t('home.markWatched')
                }
                focusable={!isTv}
                focused={isTv && focusedAction === 'watched'}
                onPress={() => onToggleWatched(slide)}
              />
            ) : null}
          </View>

          {slides.length > 1 ? (
            <View style={styles.dotsRow}>
              {slides.map((entry, idx) => {
                const selected = idx === safeIndex;
                const dotFocused = isTv && focusedAction === `dot-${idx}`;
                return (
                  <Pressable
                    key={entry.itemKey}
                    testID={`home-hero-dot-${idx}`}
                    accessibilityRole="button"
                    accessibilityLabel={i18n.t('home.heroSlideLabel', {
                      index: idx + 1,
                      total: slides.length,
                    })}
                    accessibilityState={{ selected }}
                    focusable={!isTv}
                    onPress={() => onSelectIndex(idx)}
                    style={[
                      styles.dotTouch,
                      cursor,
                      dotTransition,
                      {
                        minWidth: isTouch ? 40 : 28,
                        minHeight: isTouch ? 40 : 22,
                        borderRadius: theme.radius.pill,
                        borderWidth: dotFocused ? theme.focus.ringWidth : 0,
                        borderColor: dotFocused ? theme.colors.focusRingColor : 'transparent',
                        backgroundColor: dotFocused ? theme.colors.focusFill : 'transparent',
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.dotPill,
                        dotTransition,
                        {
                          width: selected ? 22 : 7,
                          borderRadius: theme.radius.pill,
                          backgroundColor: selected
                            ? theme.colors.ctaBg
                            : theme.colors.actionGlassHoverBg,
                        },
                      ]}
                    />
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  content: {
    position: 'relative',
    zIndex: 2,
    maxWidth: 680,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusBar: {
    width: 3,
    height: 11,
    borderRadius: 2,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  overview: {
    maxWidth: 520,
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dotTouch: {
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotPill: {
    height: 7,
  },
});

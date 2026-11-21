import { AdaptiveNavShell, type NavDestination, type NavUtility } from '@elv/features';
import {
  ArtworkImage,
  CtaButton,
  EditorialCategoryBar,
  type EditorialCategoryItem,
  HorizontalRailScroll,
  IconButton,
  MicroPill,
  PosterCard,
  Scrim,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  WideCard,
} from '@elv/ui-kit';
import { type ReactElement, useMemo, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  GalleryComponentLab,
  GalleryPreviewSheet,
  GallerySectionHeader,
  getGalleryCopy,
} from './GalleryComponentLab.tsx';
import { HERO_SPOTLIGHTS, POSTER_CATALOG, WIDE_RAIL_ITEMS } from './synthetic-art.ts';

const GENRES = ['All', 'Sci-Fi', 'Thriller', 'Documentary', 'Festival'] as const;

/**
 * Flagship Cinema Quietude showcase exercising `@elv/ui-kit` and `AdaptiveNavShell` across all
 * theme presets, device orientations, input modalities, locales, font scales, and reduceMotion.
 */
export function DesignGallery(): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();

  const [activeDest, setActiveDest] = useState<'home' | 'live' | 'movies' | 'series'>('home');
  const [heroIdx, setHeroIdx] = useState(0);
  const [selectedGenre, setSelectedGenre] = useState<(typeof GENRES)[number]>('All');
  const [inMyList, setInMyList] = useState(false);
  const [scrolledBar, setScrolledBar] = useState(false);
  const [activeSheet, setActiveSheet] = useState<'search' | 'settings' | 'info' | null>(null);
  const [tvFocusId, setTvFocusId] = useState<string>('hero-play');

  const copy = getGalleryCopy(i18n.locale);

  const isPortrait = viewport.orientation === 'portrait';
  const isTv = viewport.formFactor === 'tv';
  const tvMode = viewport.inputModality === 'tv';
  const insetTop = isTv
    ? Math.max(viewport.safeArea.top, viewport.overscan.y)
    : viewport.safeArea.top;
  const insetBottom = Math.max(
    theme.spacing.lg,
    viewport.safeArea.bottom,
    isTv ? viewport.overscan.y : 0,
  );
  const padX = Math.max(
    isPortrait ? theme.spacing.md : theme.spacing.lg,
    isTv ? viewport.overscan.x : 0,
  );
  const navBarHeight = isPortrait ? 50 : isTv ? 58 : 56;
  const heroMinHeight = isPortrait ? 310 : isTv ? 390 : 360;
  const posterW = isPortrait ? 106 : 144;
  const wideW = isPortrait ? 236 : 268;

  const hero = HERO_SPOTLIGHTS[heroIdx] ?? HERO_SPOTLIGHTS[0];
  const filteredPosters = useMemo(
    () =>
      selectedGenre === 'All'
        ? POSTER_CATALOG
        : POSTER_CATALOG.filter((item) => item.genre === selectedGenre),
    [selectedGenre],
  );
  const genreItems = useMemo<readonly EditorialCategoryItem[]>(
    () => GENRES.map((genre) => ({ id: genre, label: genre })),
    [],
  );

  const destinations = useMemo<readonly NavDestination<'home' | 'live' | 'movies' | 'series'>[]>(
    () => [
      { id: 'home', label: copy.home, icon: 'home' },
      { id: 'live', label: i18n.t('nav.live'), icon: 'tv' },
      { id: 'movies', label: i18n.t('nav.movies'), icon: 'film' },
      { id: 'series', label: i18n.t('nav.series'), icon: 'series' },
    ],
    [copy.home, i18n],
  );

  const utilities = useMemo<readonly NavUtility[]>(
    () => [
      {
        id: 'search',
        label: copy.search,
        icon: 'search',
        showLabel: false,
        active: activeSheet === 'search',
        onPress: () => setActiveSheet('search'),
      },
      {
        id: 'settings',
        label: copy.settings,
        icon: 'settings',
        showLabel: false,
        active: activeSheet === 'settings',
        onPress: () => setActiveSheet('settings'),
      },
    ],
    [activeSheet, copy.search, copy.settings],
  );

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > 24;
    if (next !== scrolledBar) setScrolledBar(next);
  };

  return (
    <AdaptiveNavShell
      brandTitle={i18n.t('app.title')}
      destinations={destinations}
      utilities={utilities}
      activeId={activeDest}
      onSelectDestination={setActiveDest}
      overlay
      frosted={scrolledBar}
    >
      <View style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
        <ScrollView
          style={styles.scroll}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: insetBottom }}
        >
          {/* Full-Bleed Cinematic Hero Spotlight */}
          <View
            style={[
              styles.hero,
              {
                minHeight: heroMinHeight,
                paddingTop: navBarHeight + insetTop + 26,
                paddingBottom: theme.spacing.lg,
                paddingHorizontal: padX,
              },
            ]}
          >
            <ArtworkImage
              uri={hero.imageUri}
              label={hero.title}
              borderRadius={0}
              style={StyleSheet.absoluteFill}
            />
            <Scrim direction="bottom" intensity="strong" />
            <Scrim direction="left" intensity="strong" />

            <View style={styles.heroContent}>
              <View style={styles.statusRow}>
                <View style={[styles.statusBar, { backgroundColor: theme.colors.accent }]} />
                <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                  {copy.isTr && heroIdx === 0 ? 'Bu Akşam Öne Çıkan · 4K HDR' : hero.statusLine}
                </Text>
              </View>

              <Text
                numberOfLines={2}
                style={[
                  isPortrait ? theme.typography.h1 : theme.typography.display,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {hero.title}
              </Text>

              <View style={styles.metaRow}>
                <Text
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    styles.matchText,
                    { color: theme.colors.successColor },
                  ]}
                >
                  {hero.match}
                </Text>
                <Text
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {`${hero.year} · ${hero.duration}`}
                </Text>
                <MicroPill label={hero.quality} />
                <MicroPill label={hero.rating} />
              </View>

              <Text
                numberOfLines={2}
                style={[
                  theme.typography.body,
                  styles.synopsis,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {hero.synopsis}
              </Text>

              <View style={styles.heroFooter}>
                <View style={styles.heroActions}>
                  <CtaButton
                    label={i18n.t('player.play')}
                    icon="play"
                    focused={tvMode && tvFocusId === 'hero-play'}
                    onPress={() => setTvFocusId('hero-play')}
                  />
                  <CtaButton
                    label={copy.moreInfo}
                    icon="info"
                    variant="secondary"
                    focused={tvMode && tvFocusId === 'hero-info'}
                    onPress={() => {
                      setTvFocusId('hero-info');
                      setActiveSheet('info');
                    }}
                  />
                  <IconButton
                    icon={inMyList ? 'check' : 'plus'}
                    accessibilityLabel={copy.myList}
                    active={inMyList}
                    focused={tvMode && tvFocusId === 'hero-list'}
                    onPress={() => {
                      setTvFocusId('hero-list');
                      setInMyList((v) => !v);
                    }}
                  />
                </View>

                <View style={styles.heroDots}>
                  {HERO_SPOTLIGHTS.map((item, idx) => {
                    const active = idx === heroIdx;
                    return (
                      <Pressable
                        key={item.id}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Show spotlight ${item.title}`}
                        onPress={() => setHeroIdx(idx)}
                        style={[
                          styles.heroDot,
                          {
                            width: active ? 22 : 7,
                            backgroundColor: active
                              ? theme.colors.textPrimary
                              : theme.colors.glassBorder,
                          },
                        ]}
                      />
                    );
                  })}
                </View>
              </View>
            </View>
          </View>

          {/* Cinema Rails Body */}
          <View style={[styles.body, { paddingHorizontal: padX, gap: theme.spacing.lg }]}>
            <View style={{ gap: theme.spacing.xs }}>
              <GallerySectionHeader
                title={`${copy.continueWatching} & ${i18n.t('nav.live')}`}
                actionLabel={copy.seeAll}
                onAction={() => setActiveDest('live')}
              />
              <HorizontalRailScroll
                testID="gallery-wide-rail"
                isTv={tvMode}
                showArrows={!tvMode}
                contentContainerStyle={styles.railContent}
              >
                {WIDE_RAIL_ITEMS.map((item) => (
                  <WideCard
                    key={item.id}
                    title={item.title}
                    subtitle={item.subtitle}
                    imageUri={item.imageUri}
                    live={Boolean(item.live)}
                    {...(item.badge ? { badge: item.badge } : {})}
                    progress={item.progress}
                    width={wideW}
                    focused={tvMode && tvFocusId === item.id}
                    onFocus={() => setTvFocusId(item.id)}
                    onPress={() => setTvFocusId(item.id)}
                  />
                ))}
              </HorizontalRailScroll>
            </View>

            <View style={{ gap: theme.spacing.sm }}>
              <GallerySectionHeader
                title={`${copy.featured} · ${i18n.t('nav.movies')} & ${i18n.t('nav.series')}`}
                actionLabel={copy.seeAll}
                onAction={() => setActiveDest('movies')}
              />
              <EditorialCategoryBar
                testID="gallery-genre-bar"
                items={genreItems}
                activeId={selectedGenre}
                onSelect={(id) => setSelectedGenre(id as (typeof GENRES)[number])}
                isTv={tvMode}
                padX={0}
              />
              <HorizontalRailScroll
                testID="gallery-poster-rail"
                isTv={tvMode}
                showArrows={!tvMode}
                contentContainerStyle={styles.railContent}
              >
                {filteredPosters.map((item) => (
                  <PosterCard
                    key={item.id}
                    title={item.title}
                    meta={item.meta}
                    imageUri={item.imageUri}
                    {...(item.badge ? { badge: item.badge } : {})}
                    {...(item.progress !== undefined ? { progress: item.progress } : {})}
                    width={posterW}
                    focused={tvMode && tvFocusId === item.id}
                    onFocus={() => setTvFocusId(item.id)}
                    onPress={() => setTvFocusId(item.id)}
                  />
                ))}
              </HorizontalRailScroll>
            </View>

            <GalleryComponentLab />
          </View>
        </ScrollView>

        <GalleryPreviewSheet
          visible={activeSheet !== null}
          title={
            activeSheet === 'search'
              ? copy.search
              : activeSheet === 'info'
                ? hero.title
                : copy.settings
          }
          closeLabel={copy.close}
          onDismiss={() => setActiveSheet(null)}
        />
      </View>
    </AdaptiveNavShell>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, position: 'relative' },
  scroll: { flex: 1 },
  hero: { position: 'relative', justifyContent: 'flex-end', overflow: 'hidden' },
  heroContent: { position: 'relative', zIndex: 2, gap: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusBar: { width: 3, height: 13, borderRadius: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  matchText: { fontWeight: '700' },
  synopsis: { maxWidth: 540 },
  heroFooter: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 6,
  },
  heroActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  heroDots: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  heroDot: { height: 7, borderRadius: 999 },
  body: { paddingTop: 18 },
  railContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
});

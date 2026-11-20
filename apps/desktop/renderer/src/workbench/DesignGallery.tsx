import {
  AdaptiveSheet,
  CtaButton,
  ErrorBoundary,
  FilterChip,
  GlassBar,
  ICON_NAMES,
  Icon,
  IconButton,
  MicroPill,
  PosterCard,
  Scrim,
  Surface,
  TABULAR_NUMS_STYLE,
  THEME_PRESETS,
  useI18n,
  useTheme,
  useViewport,
  WideCard,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

const GENRES = ['All', 'Sci-Fi', 'Thriller', 'Documentary', 'Festival'] as const;

function CrashTrigger({ explode }: { explode: boolean }): ReactElement {
  const theme = useTheme();
  if (explode) throw new Error('Simulated Workbench error');
  return (
    <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>
      Healthy child subtree
    </Text>
  );
}

/**
 * Interactive Cinema Quietude showcase exercising every `@elv/ui-kit` primitive across the active
 * theme preset, viewport orientation, input modality, locale, font scale, and reduceMotion setting.
 */
export function DesignGallery(): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const [selectedGenre, setSelectedGenre] = useState<string>('All');
  const [liked, setLiked] = useState(false);
  const [scrolledBar, setScrolledBar] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [explode, setExplode] = useState(false);

  const presetLabel = theme.preset === 'custom' ? 'Custom' : THEME_PRESETS[theme.preset].label;
  const insetTop = Math.max(viewport.safeArea.top, viewport.overscan.y);
  const insetBottom = Math.max(theme.spacing.lg, viewport.safeArea.bottom, viewport.overscan.y);
  const padLeft = Math.max(theme.spacing.lg, viewport.safeArea.left, viewport.overscan.x);
  const padRight = Math.max(theme.spacing.lg, viewport.safeArea.right, viewport.overscan.x);
  const posterW = viewport.orientation === 'portrait' ? 104 : 138;
  const wideW = viewport.orientation === 'portrait' ? 240 : 260;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      <GlassBar
        scrolled={scrolledBar}
        style={{ height: 54 + insetTop, paddingTop: insetTop }}
        contentStyle={{
          paddingLeft: padLeft,
          paddingRight: padRight,
          justifyContent: 'space-between',
        }}
      >
        <View style={styles.row}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {i18n.t('app.title')}
          </Text>
          <MicroPill label={presetLabel} tone={theme.highContrast ? 'accent' : 'neutral'} />
          <MicroPill label={i18n.locale.toUpperCase()} />
        </View>
        <View style={styles.row}>
          <IconButton
            icon="layers"
            accessibilityLabel="Toggle GlassBar state"
            active={scrolledBar}
            onPress={() => setScrolledBar((v) => !v)}
          />
          <IconButton
            icon="settings"
            accessibilityLabel="Open AdaptiveSheet"
            active={sheetOpen}
            onPress={() => setSheetOpen(true)}
          />
        </View>
      </GlassBar>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingLeft: padLeft,
          paddingRight: padRight,
          paddingTop: theme.spacing.md,
          paddingBottom: insetBottom,
          gap: theme.spacing.lg,
        }}
      >
        <Surface tone="elevated" bordered rounded="modal" style={styles.heroBanner}>
          <Scrim direction="left" intensity="strong" />
          <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
            <View style={styles.row}>
              <MicroPill label="4K HDR" />
              <MicroPill label="98%" tone="success" dot />
              <MicroPill label={i18n.t('ui.liveBadge')} tone="live" />
            </View>
            <Text style={[theme.typography.h1, { color: theme.colors.textPrimary }]}>
              Silent Horizon
            </Text>
            <Text
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textSecondary },
              ]}
            >
              {`${viewport.formFactor.toUpperCase()} · ${viewport.orientation} · ${viewport.inputModality} · ${viewport.width}×${viewport.height} · ${Math.round(theme.fontScale * 100)}%`}
            </Text>
            <View style={[styles.row, { flexWrap: 'wrap', marginTop: theme.spacing.xs }]}>
              <CtaButton label={i18n.t('player.play')} icon="play" onPress={() => undefined} />
              <CtaButton
                label={i18n.t('nav.sources')}
                icon="info"
                variant="secondary"
                focused={viewport.inputModality === 'tv'}
                onPress={() => setSheetOpen(true)}
              />
              <CtaButton label={i18n.t('player.back')} variant="ghost" onPress={() => undefined} />
              <IconButton
                icon={liked ? 'check' : 'plus'}
                accessibilityLabel="My List"
                active={liked}
                onPress={() => setLiked((v) => !v)}
              />
            </View>
          </View>
        </Surface>

        <View style={{ gap: theme.spacing.xs }}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {`${i18n.t('browse.categories')} (FilterChip)`}
          </Text>
          <View style={[styles.row, { flexWrap: 'wrap', padding: 6 }]}>
            {GENRES.map((genre) => (
              <FilterChip
                key={genre}
                label={genre}
                selected={selectedGenre === genre}
                onPress={() => setSelectedGenre(genre)}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: theme.spacing.xs }}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {`${i18n.t('nav.live')} (16:9 WideCard)`}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.railContent}
          >
            <WideCard
              title="Cinema One 4K"
              subtitle="Ch 101 · Silent Horizon"
              live
              badge="UHD"
              progress={0.62}
              width={wideW}
              focused={viewport.inputModality === 'tv'}
            />
            <WideCard
              title="Arena Sports 1"
              subtitle="Ch 201 · Evening Match"
              live
              logoBackdrop
              progress={0.35}
              width={wideW}
            />
            <WideCard
              title="Northern Signal · S1 E2"
              subtitle="24m left"
              progress={0.54}
              width={wideW}
            />
          </ScrollView>
        </View>

        <View style={{ gap: theme.spacing.xs }}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {`${i18n.t('nav.movies')} & ${i18n.t('nav.series')} (2:3 PosterCard)`}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.railContent}
          >
            <PosterCard title="Silent Horizon" meta="2026 · 8.6" badge="4K" width={posterW} />
            <PosterCard
              title="Orbital Nine"
              meta="2025 · 8.2"
              progress={0.4}
              width={posterW}
              focused={viewport.inputModality === 'tv'}
            />
            <PosterCard title="Harbor Lights" meta="2025 · 8.1" width={posterW} />
            <PosterCard title="Paper Lanterns" meta="2026 · 8.5" badge="HDR" width={posterW} />
          </ScrollView>
        </View>

        <View style={{ gap: theme.spacing.xs }}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {`Icon Registry (${ICON_NAMES.length})`}
          </Text>
          <Surface tone="surface" bordered rounded="card" style={styles.iconGrid}>
            {ICON_NAMES.map((name) => (
              <View key={name} style={styles.iconCell}>
                <Icon name={name} size={18} color={theme.colors.textPrimary} />
                <Text
                  numberOfLines={1}
                  style={[theme.typography.micro, { color: theme.colors.textMuted }]}
                >
                  {name}
                </Text>
              </View>
            ))}
          </Surface>
        </View>

        <View style={{ gap: theme.spacing.xs }}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            ErrorBoundary Recovery Demo
          </Text>
          <Surface tone="surface" bordered rounded="card" style={{ padding: theme.spacing.md }}>
            <ErrorBoundary onReset={() => setExplode(false)}>
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <CrashTrigger explode={explode} />
                <CtaButton
                  label="Simulate Crash"
                  variant="secondary"
                  onPress={() => setExplode(true)}
                />
              </View>
            </ErrorBoundary>
          </Surface>
        </View>
      </ScrollView>

      <AdaptiveSheet
        visible={sheetOpen}
        title="Adaptive Sheet Preview"
        onDismiss={() => setSheetOpen(false)}
      >
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {viewport.orientation === 'portrait'
            ? 'Portrait viewport: inset bottom sheet with grab handle.'
            : 'Landscape viewport: right-anchored 300px frosted popover.'}
        </Text>
        <View style={{ marginTop: theme.spacing.md }}>
          <CtaButton label="Close" variant="secondary" onPress={() => setSheetOpen(false)} />
        </View>
      </AdaptiveSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
  },
  scroll: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  railContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  heroBanner: {
    overflow: 'hidden',
    position: 'relative',
  },
  iconGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 12,
    gap: 10,
  },
  iconCell: {
    width: 72,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
  },
});

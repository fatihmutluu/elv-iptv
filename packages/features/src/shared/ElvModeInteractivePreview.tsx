import {
  hexToRgba,
  Surface,
  TABULAR_NUMS_STYLE,
  THEME_PRESETS,
  type Theme,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import { type ReactElement, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  buildElvPreviewState,
  type ElvPreviewArtworkId,
  type ElvPreviewCard,
} from './elv-preview-model';

/** Props of {@link ElvModeInteractivePreview}. */
export interface ElvModeInteractivePreviewProps {
  /** Master ELV Mode switch gating all visual enhancements. */
  readonly elvModeEnabled: boolean;
  /** Whether duplicate provider copies merge into 4 distinct cinema titles. */
  readonly mergeVersions: boolean;
  /** Whether clean layered cinema posters and IMDb ratings replace raw broken cards. */
  readonly enrichMetadata: boolean;
  /** Whether clean curated genre tabs replace raw IPTV spam folder names. */
  readonly imdbCategories: boolean;
  /** Compact density for `Settings -> ELV Mode` top preview slot. */
  readonly compact?: boolean;
  /** Optional root testID (defaults to `'elv-preview-root'`). */
  readonly testID?: string;
}

interface PosterPalette {
  readonly base: string;
  readonly primary: string;
  readonly secondary: string;
  readonly highlight: string;
  readonly floor: string;
}

function resolvePosterPalette(artworkId: ElvPreviewArtworkId, theme: Theme): PosterPalette {
  if (theme.highContrast) {
    return {
      base: theme.colors.bgCard,
      primary: hexToRgba(theme.colors.accent, 0.35),
      secondary: hexToRgba(theme.colors.textPrimary, 0.22),
      highlight: hexToRgba(theme.colors.accent, 0.65),
      floor: hexToRgba(theme.colors.bgCanvas, 0.88),
    };
  }
  const p = THEME_PRESETS;
  if (artworkId === 'velvet-meridian') {
    return {
      base: p.obsidianCrimson.bgCard,
      primary: hexToRgba(p.obsidianCrimson.accent, 0.48),
      secondary: hexToRgba(p.obsidianCrimson.accentSecondary, 0.26),
      highlight: hexToRgba(p.obsidianCrimson.textPrimary, 0.28),
      floor: hexToRgba(p.obsidianCrimson.bgCanvas, 0.78),
    };
  }
  if (artworkId === 'solar-drift') {
    return {
      base: p.theaterAmber.bgCard,
      primary: hexToRgba(p.theaterAmber.accent, 0.56),
      secondary: hexToRgba(p.theaterAmber.accentSecondary, 0.34),
      highlight: p.theaterAmber.bgCanvas,
      floor: hexToRgba(p.theaterAmber.bgCanvas, 0.82),
    };
  }
  if (artworkId === 'glass-harbor') {
    return {
      base: p.abyssalSapphire.bgCard,
      primary: hexToRgba(p.abyssalSapphire.accent, 0.44),
      secondary: hexToRgba(p.pitchEmerald.accent, 0.3),
      highlight: hexToRgba(p.abyssalSapphire.accentSecondary, 0.42),
      floor: hexToRgba(p.abyssalSapphire.bgCanvas, 0.8),
    };
  }
  return {
    base: p.velvetViolet.bgCard,
    primary: hexToRgba(p.velvetViolet.accent, 0.44),
    secondary: hexToRgba(p.obsidianCrimson.accentSecondary, 0.36),
    highlight: hexToRgba(p.velvetViolet.accentSecondary, 0.38),
    floor: hexToRgba(p.velvetViolet.bgCanvas, 0.82),
  };
}

function CleanPosterComposition({
  artworkId,
  theme,
}: {
  readonly artworkId: ElvPreviewArtworkId;
  readonly theme: Theme;
}): ReactElement {
  const c = resolvePosterPalette(artworkId, theme);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.base }]}>
      {artworkId === 'velvet-meridian' ? (
        <>
          <View style={[s.meridianOrb, { backgroundColor: c.primary, borderColor: c.secondary }]} />
          <View style={[s.meridianBeam, { backgroundColor: c.secondary }]} />
          <View style={[s.meridianLine, { backgroundColor: c.highlight }]} />
        </>
      ) : artworkId === 'solar-drift' ? (
        <>
          <View style={[s.solarCorona, { borderColor: c.secondary }]} />
          <View style={[s.solarSun, { backgroundColor: c.primary }]} />
          <View style={[s.solarEclipse, { backgroundColor: c.highlight }]} />
        </>
      ) : artworkId === 'glass-harbor' ? (
        <>
          <View style={[s.harborLeft, { backgroundColor: c.primary }]} />
          <View style={[s.harborMid, { backgroundColor: c.secondary }]} />
          <View style={[s.harborRight, { backgroundColor: c.primary }]} />
          <View style={[s.harborPrism, { borderColor: c.highlight }]} />
        </>
      ) : (
        <>
          <View style={[s.cinderBeamA, { backgroundColor: c.primary }]} />
          <View style={[s.cinderBeamB, { backgroundColor: c.secondary }]} />
          <View style={[s.cinderRing, { borderColor: c.highlight }]} />
        </>
      )}
      <View style={[s.horizonFloor, { backgroundColor: c.floor }]} />
      <View style={[s.posterScrim, { backgroundColor: hexToRgba(theme.colors.bgCanvas, 0.52) }]} />
    </View>
  );
}

function PreviewCardTile({
  card,
  index,
  compact,
  theme,
}: {
  readonly card: ElvPreviewCard;
  readonly index: number;
  readonly compact: boolean;
  readonly theme: Theme;
}): ReactElement {
  const i18n = useI18n();
  const isCleanMerged = !card.isDuplicate && card.cleanPoster && card.titleKey !== null;
  const displayTitle =
    isCleanMerged && card.titleKey !== null ? i18n.t(card.titleKey) : card.rawFilename;
  const subMetaText = card.cleanPoster ? card.year : card.rawQualityTag;

  return (
    <View testID={`elv-preview-card-${index}`} style={s.cardCol}>
      <View
        style={[
          s.posterFrame,
          {
            borderRadius: theme.radius.card,
            borderColor: card.cleanPoster ? theme.colors.glassBorder : theme.colors.dangerBorder,
            borderStyle: card.cleanPoster ? 'solid' : 'dashed',
            backgroundColor: theme.colors.bgRail,
          },
        ]}
      >
        {card.cleanPoster ? (
          <View testID={`elv-preview-clean-poster-${index}`} style={StyleSheet.absoluteFill}>
            <CleanPosterComposition artworkId={card.artworkId} theme={theme} />
            <View
              style={[
                s.ratingBadge,
                {
                  backgroundColor: theme.colors.scrimStrong,
                  borderColor: theme.colors.glassBorder,
                  borderRadius: theme.radius.button,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.micro,
                  TABULAR_NUMS_STYLE,
                  s.badgeTxt,
                  { color: theme.colors.successColor },
                ]}
              >
                ★
              </Text>
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.micro,
                  TABULAR_NUMS_STYLE,
                  s.badgeTxt,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {card.rating}
              </Text>
            </View>
            {card.isDuplicate ? (
              <View
                style={[
                  s.dupBadge,
                  { backgroundColor: theme.colors.dangerBg, borderRadius: theme.radius.button },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[theme.typography.micro, s.badgeTxt, { color: theme.colors.dangerFg }]}
                >
                  {i18n.t('elv.preview.duplicateTag')}
                </Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View testID={`elv-preview-chaos-poster-${index}`} style={s.chaosLayer}>
            <View
              style={[s.glitchTop, { backgroundColor: hexToRgba(theme.colors.dangerBorder, 0.24) }]}
            />
            <View
              style={[s.glitchMid, { backgroundColor: hexToRgba(theme.colors.textMuted, 0.22) }]}
            />
            <View
              style={[s.glitchBot, { backgroundColor: hexToRgba(theme.colors.accent, 0.18) }]}
            />
            <View style={s.chaosTopRow}>
              <View
                style={[
                  s.chaosTag,
                  {
                    backgroundColor: card.isDuplicate
                      ? hexToRgba(theme.colors.dangerBg, 0.85)
                      : theme.colors.bgElevated,
                    borderColor: theme.colors.surfaceBorder,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.micro,
                    s.chaosTxt,
                    { color: card.isDuplicate ? theme.colors.dangerFg : theme.colors.textMuted },
                  ]}
                >
                  {card.isDuplicate ? i18n.t('elv.preview.duplicateTag') : card.rawQualityTag}
                </Text>
              </View>
              <View
                style={[
                  s.chaosTag,
                  {
                    backgroundColor: theme.colors.bgElevated,
                    borderColor: theme.colors.surfaceBorder,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.micro,
                    TABULAR_NUMS_STYLE,
                    s.chaosTxt,
                    { color: theme.colors.textMuted },
                  ]}
                >
                  {i18n.t('elv.preview.rawNoRating')}
                </Text>
              </View>
            </View>
            <View
              style={[
                s.brokenBox,
                {
                  backgroundColor: hexToRgba(theme.colors.bgCanvas, 0.78),
                  borderColor: theme.colors.surfaceBorder,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.micro, s.brokenTxt, { color: theme.colors.dangerBorder }]}
              >
                {i18n.t('elv.preview.rawNoPoster')}
              </Text>
            </View>
          </View>
        )}
      </View>

      <View style={s.metaBlock}>
        <Text
          numberOfLines={isCleanMerged ? 1 : 2}
          style={[
            compact ? theme.typography.micro : theme.typography.caption,
            s.cardTitle,
            {
              color: isCleanMerged ? theme.colors.textPrimary : theme.colors.textSecondary,
              fontWeight: isCleanMerged ? '600' : '500',
            },
          ]}
        >
          {displayTitle}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            theme.typography.micro,
            TABULAR_NUMS_STYLE,
            s.cardSub,
            { color: card.cleanPoster ? theme.colors.textSecondary : theme.colors.textMuted },
          ]}
        >
          {subMetaText}
        </Text>
      </View>
    </View>
  );
}

/**
 * Shared live 4-card interactive ELV Mode preview (`#513`), mounted identically in both
 * Onboarding Screen 3 and `Settings -> ELV Mode`. Renders purely cross-platform React Native
 * `<View>` / `<Text>` / `<Surface>` layers (zero hardcoded hex, zero SVG, zero RN `<Modal>`,
 * non-focusable so 10-ft TV D-pad jumps cleanly to interactive controls).
 */
export function ElvModeInteractivePreview({
  elvModeEnabled,
  mergeVersions,
  enrichMetadata,
  imdbCategories,
  compact = false,
  testID = 'elv-preview-root',
}: ElvModeInteractivePreviewProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const state = useMemo(
    () => buildElvPreviewState({ elvModeEnabled, mergeVersions, enrichMetadata, imdbCategories }),
    [elvModeEnabled, enrichMetadata, imdbCategories, mergeVersions],
  );

  const badgeBg = state.allClean
    ? hexToRgba(theme.colors.successColor, theme.highContrast ? 0.28 : 0.16)
    : hexToRgba(theme.colors.dangerBg, theme.highContrast ? 0.42 : 0.24);
  const badgeBorder = state.allClean
    ? hexToRgba(theme.colors.successColor, 0.5)
    : hexToRgba(theme.colors.dangerBorder, 0.55);
  const badgeFg = state.allClean ? theme.colors.successColor : theme.colors.dangerBorder;

  return (
    <Surface
      testID={testID}
      tone="surface"
      bordered
      rounded="modal"
      pointerEvents="none"
      style={[
        s.container,
        {
          padding: compact ? theme.spacing.sm + 4 : theme.spacing.md,
          gap: compact ? theme.spacing.sm : theme.spacing.sm + 2,
          borderColor: state.allClean ? theme.colors.glassBorder : theme.colors.surfaceBorder,
          backgroundColor: theme.colors.bgSurface,
        },
      ]}
    >
      <View style={s.headerRow}>
        <View
          testID="elv-preview-status-badge"
          style={[
            s.statusBadge,
            { backgroundColor: badgeBg, borderColor: badgeBorder, borderRadius: theme.radius.pill },
          ]}
        >
          <View style={[s.statusDot, { backgroundColor: badgeFg }]} />
          <Text numberOfLines={1} style={[theme.typography.micro, { color: badgeFg }]}>
            {i18n.t(state.badgeKey)}
          </Text>
        </View>
        <Text
          numberOfLines={compact ? 1 : 2}
          style={[theme.typography.caption, s.captionTxt, { color: theme.colors.textSecondary }]}
        >
          {i18n.t(state.captionKey)}
        </Text>
      </View>

      <View
        testID="elv-preview-categories"
        style={[
          s.catRow,
          state.effectiveCategories
            ? {
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.surfaceBorder,
                gap: theme.spacing.md,
              }
            : { gap: theme.spacing.xs },
        ]}
      >
        {state.categories.map((cat) =>
          cat.clean ? (
            <View key={cat.id} style={s.cleanCatTab}>
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  {
                    color: cat.active ? theme.colors.textPrimary : theme.colors.textSecondary,
                    fontWeight: cat.active ? '700' : '500',
                  },
                ]}
              >
                {i18n.t(cat.labelKey)}
              </Text>
              {cat.active ? (
                <View style={[s.cleanCatBar, { backgroundColor: theme.colors.accent }]} />
              ) : null}
            </View>
          ) : (
            <View
              key={cat.id}
              style={[
                s.rawCat,
                { backgroundColor: theme.colors.bgRail, borderColor: theme.colors.surfaceBorder },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.micro, s.rawCatTxt, { color: theme.colors.textMuted }]}
              >
                {i18n.t(cat.labelKey)}
              </Text>
            </View>
          ),
        )}
      </View>

      <View
        testID="elv-preview-cards"
        style={[s.cardsGrid, { gap: compact ? theme.spacing.xs + 2 : theme.spacing.sm }]}
      >
        {state.cards.map((card, index) => (
          <PreviewCardTile
            key={card.id}
            card={card}
            index={index}
            compact={compact}
            theme={theme}
          />
        ))}
      </View>
    </Surface>
  );
}

const s = StyleSheet.create({
  container: { width: '100%', overflow: 'hidden' },
  headerRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  captionTxt: { flex: 1, minWidth: 180 },
  catRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  cleanCatTab: { position: 'relative', paddingBottom: 6 },
  cleanCatBar: { position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, borderRadius: 1 },
  rawCat: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 2,
    maxWidth: '48%',
  },
  rawCatTxt: { fontSize: 9.5, lineHeight: 12 },
  cardsGrid: { flexDirection: 'row', alignItems: 'flex-start' },
  cardCol: { flex: 1, minWidth: 0, gap: 5 },
  posterFrame: {
    width: '100%',
    aspectRatio: 2 / 3,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
  },
  posterScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '36%' },
  horizonFloor: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '26%' },
  meridianOrb: {
    position: 'absolute',
    top: '18%',
    left: '20%',
    width: '60%',
    aspectRatio: 1,
    borderRadius: 999,
    borderWidth: 2,
  },
  meridianBeam: {
    position: 'absolute',
    top: '-10%',
    right: '14%',
    width: '28%',
    height: '120%',
    transform: [{ rotate: '14deg' }],
  },
  meridianLine: { position: 'absolute', top: '10%', left: '49%', width: 1.5, height: '72%' },
  solarCorona: {
    position: 'absolute',
    top: '14%',
    left: '16%',
    width: '68%',
    aspectRatio: 1,
    borderRadius: 999,
    borderWidth: 2,
  },
  solarSun: {
    position: 'absolute',
    top: '21%',
    left: '23%',
    width: '54%',
    aspectRatio: 1,
    borderRadius: 999,
  },
  solarEclipse: {
    position: 'absolute',
    top: '26%',
    left: '29%',
    width: '44%',
    aspectRatio: 1,
    borderRadius: 999,
  },
  harborLeft: {
    position: 'absolute',
    top: '14%',
    left: '16%',
    width: '16%',
    height: '64%',
    borderRadius: 3,
  },
  harborMid: {
    position: 'absolute',
    top: '24%',
    left: '42%',
    width: '18%',
    height: '54%',
    borderRadius: 3,
  },
  harborRight: {
    position: 'absolute',
    top: '18%',
    right: '14%',
    width: '14%',
    height: '60%',
    borderRadius: 3,
  },
  harborPrism: {
    position: 'absolute',
    top: '14%',
    left: '36%',
    width: '28%',
    aspectRatio: 1,
    borderWidth: 1.5,
    transform: [{ rotate: '45deg' }],
  },
  cinderBeamA: {
    position: 'absolute',
    top: '-12%',
    left: '8%',
    width: '34%',
    height: '125%',
    transform: [{ rotate: '-18deg' }],
  },
  cinderBeamB: {
    position: 'absolute',
    top: '-8%',
    right: '6%',
    width: '30%',
    height: '120%',
    transform: [{ rotate: '16deg' }],
  },
  cinderRing: {
    position: 'absolute',
    top: '28%',
    left: '24%',
    width: '52%',
    aspectRatio: 1,
    borderRadius: 999,
    borderWidth: 2,
  },
  ratingBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderWidth: 1,
  },
  dupBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: '58%',
  },
  badgeTxt: { fontSize: 9.5, lineHeight: 12 },
  chaosLayer: { flex: 1, justifyContent: 'space-between', padding: 6, overflow: 'hidden' },
  glitchTop: {
    position: 'absolute',
    top: '20%',
    left: -10,
    right: -10,
    height: 8,
    transform: [{ rotate: '-5deg' }],
  },
  glitchMid: {
    position: 'absolute',
    top: '52%',
    left: -10,
    right: -10,
    height: 12,
    transform: [{ rotate: '4deg' }],
  },
  glitchBot: {
    position: 'absolute',
    bottom: '16%',
    left: -10,
    right: -10,
    height: 7,
    transform: [{ rotate: '-3deg' }],
  },
  chaosTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 4,
  },
  chaosTag: {
    paddingHorizontal: 4,
    paddingVertical: 1.5,
    borderWidth: 1,
    borderRadius: 2,
    maxWidth: '64%',
  },
  chaosTxt: { fontSize: 8.5, lineHeight: 11 },
  brokenBox: {
    alignSelf: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 2,
    marginBottom: '20%',
    transform: [{ rotate: '-3deg' }],
    maxWidth: '94%',
  },
  brokenTxt: { fontSize: 8.5, lineHeight: 11, textAlign: 'center' },
  metaBlock: { gap: 2 },
  cardTitle: { lineHeight: 15 },
  cardSub: { fontSize: 10, lineHeight: 13 },
});

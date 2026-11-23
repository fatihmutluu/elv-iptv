import { foldText } from './fold';

/** Parsed quality metadata and normalized base fold for a live channel title (`#218`). */
export interface ParsedLiveVariant {
  /** Folded channel base name with bounded quality tokens removed (preserving East/West/+1/Backup/language). */
  readonly baseFold: string;
  /** Canonical quality label (`4K`, `FHD`, `HD`, `SD`, `LOW`, or `''` when unspecified). */
  readonly qualityLabel: string;
  /** Numeric quality rank (`40` for 4K, `30` FHD, `20` HD, `15` default, `10` SD, `5` LOW). */
  readonly qualityRank: number;
}

const DEFAULT_QUALITY_RANK = 15;

interface QualityTier {
  readonly label: string;
  readonly rank: number;
}

const QUALITY_TIERS: Readonly<Record<string, QualityTier>> = {
  '4K': { label: '4K', rank: 40 },
  UHD: { label: '4K', rank: 40 },
  '2160P': { label: '4K', rank: 40 },
  FHD: { label: 'FHD', rank: 30 },
  '1080P': { label: 'FHD', rank: 30 },
  HD: { label: 'HD', rank: 20 },
  '720P': { label: 'HD', rank: 20 },
  SD: { label: 'SD', rank: 10 },
  '480P': { label: 'SD', rank: 10 },
  LOW: { label: 'LOW', rank: 5 },
  '360P': { label: 'LOW', rank: 5 },
};

const QUALITY_TOKEN_RE =
  /(?<![\p{L}\p{N}])(?:\[\s*(4K|UHD|2160P|FHD|1080P|HD|720P|SD|480P|LOW|360P)\s*\]|\(\s*(4K|UHD|2160P|FHD|1080P|HD|720P|SD|480P|LOW|360P)\s*\)|(4K|UHD|2160P|FHD|1080P|HD|720P|SD|480P|LOW|360P))(?![\p{L}\p{N}])/giu;

const TIMESHIFT_PLUS_RE = /(?:^|\s)\+(\d+)(?=\s|$|[)\]|:,-])/g;

function preserveTimeshiftPlus(text: string): string {
  return text.replace(TIMESHIFT_PLUS_RE, ' plus$1');
}

/**
 * Extracts bounded live channel quality metadata (`4K`/`UHD`/`2160p`, `FHD`/`1080p`, `HD`/`720p`,
 * `SD`/`480p`, `LOW`/`360p`) and computes the normalized `baseFold` used for within-category
 * variant collapsing (`#218`). Never strips substrings inside words (`4KIDS`, `HGTV`), and
 * preserves `East`/`West`, `+1`/`+2` timeshifts, `Backup`, and language/country tags.
 */
export function parseLiveVariant(title: string): ParsedLiveVariant {
  const trimmed = title.trim();
  if (trimmed === '') {
    return { baseFold: '', qualityLabel: '', qualityRank: DEFAULT_QUALITY_RANK };
  }

  let bestLabel = '';
  let bestRank = -1;

  const stripped = trimmed.replace(
    QUALITY_TOKEN_RE,
    (_full, g1: string | undefined, g2: string | undefined, g3: string | undefined) => {
      const token = (g1 ?? g2 ?? g3 ?? '').toUpperCase();
      const tier = QUALITY_TIERS[token];
      if (tier !== undefined && tier.rank > bestRank) {
        bestRank = tier.rank;
        bestLabel = tier.label;
      }
      return ' ';
    },
  );

  const foldedStripped = foldText(preserveTimeshiftPlus(stripped));
  const baseFold =
    foldedStripped.length > 0 ? foldedStripped : foldText(preserveTimeshiftPlus(trimmed));

  return {
    baseFold,
    qualityLabel: bestLabel,
    qualityRank: bestRank >= 0 ? bestRank : DEFAULT_QUALITY_RANK,
  };
}

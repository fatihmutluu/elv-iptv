import type { SqlDriver, SqlValue } from '@elv/domain';
import { escapeLikePattern } from './elv-enrichment-search';
import { uniqueNonEmpty } from './elv-enrichment-types';
import { foldText } from './fold';
import { normalizeGuideName } from './guide-match';
import { cleanDisplayTitle } from './title-clean';

/** Result of clean-name EPG channel matching when a live channel lacks a `tvg-id` (`#511`). */
export interface CleanNameGuideMatch {
  readonly sourceId: string;
  readonly guideId: string;
  readonly guideName: string;
  readonly matchedBy: 'exact-fold' | 'clean-name';
}

/** Optional cross-source and profile-isolation filters for {@link findGuideChannelByCleanName}. */
export interface FindGuideChannelByCleanNameOptions {
  /** When `true`, falls back to active guide channels from other sources if none match `sourceId`. */
  readonly crossSource?: boolean;
  /** Source IDs excluded for the active profile; excluded directly in SQL (`#511`). */
  readonly excludedSourceIds?: readonly string[];
}

/** Input parameters for {@link findGuideChannelByCleanName}. */
export interface FindGuideChannelByCleanNameInput extends FindGuideChannelByCleanNameOptions {
  readonly sourceId: string;
  readonly channelName: string;
}

const LIVE_EPG_NOISE_TOKENS: ReadonlySet<string> = new Set([
  '4k',
  '8k',
  'uhd',
  '2160p',
  'fhd',
  '1080p',
  'hd',
  '720p',
  'sd',
  '480p',
  'low',
  '360p',
  'hevc',
  'h265',
  'h264',
  'x265',
  'x264',
  'raw',
  'vip',
  '50fps',
  '60fps',
  'backup',
  'bk',
  'alt',
  'hdr',
  'hdr10',
  'dolby',
  'atmos',
  'multi',
  'sub',
  'dub',
]);

const TIMESHIFT_PLUS_RE = /(?:^|\s)\+(\d+)(?=\s|$|[)\]|:,-])/g;
const BRACKET_TAG_RE = /[[(]([^[\]()]{1,32})[\])]/g;
const TWO_LETTER_UPPER_RE = /^[A-Z]{2}$/;

function isLiveNoiseGroup(inner: string): boolean {
  const atoms = inner
    .trim()
    .split(/[\s/+._|,-]+/)
    .filter(Boolean);
  if (atoms.length === 0) return false;
  return atoms.every(
    (a) => TWO_LETTER_UPPER_RE.test(a) || LIVE_EPG_NOISE_TOKENS.has(a.toLowerCase()),
  );
}

/**
 * Strips provider prefixes (`TR:`, `UK |`, `[VIP]`), bracketed noise tags, and broadcast quality/codec/backup
 * suffixes (`4K`, `FHD`, `HD`, `HEVC`, `50fps`, `RAW`, `Backup`) while preserving channel numbers and
 * `+1`/`+2` timeshift suffixes (`plus1`/`plus2`) for Live TV ELV Mode EPG fallback matching (`#511`).
 */
export function normalizeLiveEpgTitle(rawTitle: string): string {
  const cleaned = cleanDisplayTitle(rawTitle);
  if (cleaned === '') return '';

  const withTimeshift = cleaned.replace(TIMESHIFT_PLUS_RE, ' plus$1');
  const withoutNoiseBrackets = withTimeshift.replace(BRACKET_TAG_RE, (full, inner: string) =>
    isLiveNoiseGroup(inner) ? ' ' : full,
  );
  const folded = foldText(withoutNoiseBrackets);
  if (folded === '') return '';

  const filtered = folded
    .split(' ')
    .filter((token) => !LIVE_EPG_NOISE_TOKENS.has(token))
    .join(' ');
  return filtered !== '' ? filtered : folded;
}

interface RawGuideChannelRow {
  readonly source_id: string;
  readonly guide_id: string;
  readonly name: string;
  readonly name_fold: string;
  readonly has_programmes: number;
}

function pickBestGuideMatch(
  candidates: readonly RawGuideChannelRow[],
  preferredSourceId: string,
): RawGuideChannelRow {
  return [...candidates].sort((a, b) => {
    const aPref = a.source_id === preferredSourceId ? 0 : 1;
    const bPref = b.source_id === preferredSourceId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (b.has_programmes !== a.has_programmes) return b.has_programmes - a.has_programmes;
    return a.guide_id.localeCompare(b.guide_id);
  })[0] as RawGuideChannelRow;
}

const MAX_LIVE_EPG_CANDIDATE_ROWS = 250;

const GENERIC_LIVE_TOKENS: ReadonlySet<string> = new Set([
  'the',
  'tv',
  'ch',
  'channel',
  'east',
  'west',
  'north',
  'south',
  'news',
  'sport',
  'sports',
  'live',
  'plus',
  'network',
  'television',
]);

function pickPrimaryFoldedToken(cleanFold: string): string | null {
  const tokens = cleanFold
    .split(' ')
    .filter((token) => token.length >= 2 && !/^plus\d+$/.test(token));
  if (tokens.length === 0) return null;
  const nonNumericSpecific = tokens.find(
    (token) => !GENERIC_LIVE_TOKENS.has(token) && !/^\d+$/.test(token),
  );
  if (nonNumericSpecific !== undefined) return nonNumericSpecific;
  const specific = tokens.find((token) => !GENERIC_LIVE_TOKENS.has(token));
  return specific ?? tokens[0] ?? null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Finds the best matching `guide_channels` entry for a live channel missing `tvg-id` by matching
 * its exact folded display name first, then falling back to a bounded SQL token pre-filter
 * (`LIMIT 250`) and cleaned ELV live title normalization (preferring guide channels that actually
 * have stored `programmes`, `#511`).
 */
export async function findGuideChannelByCleanName(
  db: SqlDriver,
  input: FindGuideChannelByCleanNameInput,
): Promise<CleanNameGuideMatch | null> {
  const rawFold = foldText(input.channelName);
  const cleanFold = normalizeLiveEpgTitle(input.channelName);
  if (rawFold === '' && cleanFold === '') return null;

  const excludedSourceIds = uniqueNonEmpty(input.excludedSourceIds ?? []);
  if (input.crossSource !== true && excludedSourceIds.includes(input.sourceId)) {
    return null;
  }

  const filterClauses: string[] = [];
  const filterParams: SqlValue[] = [];
  if (input.crossSource !== true) {
    filterClauses.push('gc.source_id = ?');
    filterParams.push(input.sourceId);
  }
  if (excludedSourceIds.length > 0) {
    filterClauses.push(`gc.source_id NOT IN (${placeholders(excludedSourceIds.length)})`);
    filterParams.push(...excludedSourceIds);
  }
  const extraWhere = filterClauses.length > 0 ? `AND ${filterClauses.join(' AND ')}` : '';

  // Fast path: indexed/exact name_fold match
  const exactTargets = rawFold === cleanFold || cleanFold === '' ? [rawFold] : [rawFold, cleanFold];
  const exactPh = placeholders(exactTargets.length);
  const exactRows = await db.all<RawGuideChannelRow>(
    `SELECT gc.source_id, gc.guide_id, gc.name, gc.name_fold,
            EXISTS (SELECT 1 FROM programmes p WHERE p.source_id = gc.source_id AND p.guide_id = gc.guide_id) AS has_programmes
       FROM guide_channels gc
       JOIN sources s ON s.id = gc.source_id AND s.deleting = 0
      WHERE gc.name_fold IN (${exactPh}) ${extraWhere}`,
    [...exactTargets, ...filterParams],
  );
  if (exactRows.length > 0) {
    const winner = pickBestGuideMatch(exactRows, input.sourceId);
    return {
      sourceId: winner.source_id,
      guideId: winner.guide_id,
      guideName: winner.name,
      matchedBy: 'exact-fold',
    };
  }

  if (cleanFold === '') return null;
  const primaryToken = pickPrimaryFoldedToken(cleanFold);
  if (primaryToken === null) return null;

  // Bounded SQL pre-filter: match primary folded token (>= 2 chars) with hard LIMIT 250
  const likePattern = `%${escapeLikePattern(primaryToken)}%`;
  const candidateRows = await db.all<RawGuideChannelRow>(
    `SELECT gc.source_id, gc.guide_id, gc.name, gc.name_fold,
            EXISTS (SELECT 1 FROM programmes p WHERE p.source_id = gc.source_id AND p.guide_id = gc.guide_id) AS has_programmes
       FROM guide_channels gc
       JOIN sources s ON s.id = gc.source_id AND s.deleting = 0
      WHERE (LOWER(gc.name) LIKE ? ESCAPE '\\' OR gc.name_fold LIKE ? ESCAPE '\\') ${extraWhere}
      ORDER BY CASE WHEN gc.source_id = ? THEN 0 ELSE 1 END ASC, gc.guide_id ASC
      LIMIT ?`,
    [likePattern, likePattern, ...filterParams, input.sourceId, MAX_LIVE_EPG_CANDIDATE_ROWS],
  );

  const normalizedGuideTarget = normalizeGuideName(cleanDisplayTitle(input.channelName));
  const matches = candidateRows.filter((row) => {
    const gcClean = normalizeLiveEpgTitle(row.name);
    if (gcClean === cleanFold) return true;
    if (normalizedGuideTarget !== '' && normalizeGuideName(row.name) === normalizedGuideTarget) {
      return true;
    }
    return false;
  });

  if (matches.length === 0) return null;
  const winner = pickBestGuideMatch(matches, input.sourceId);
  return {
    sourceId: winner.source_id,
    guideId: winner.guide_id,
    guideName: winner.name,
    matchedBy: 'clean-name',
  };
}

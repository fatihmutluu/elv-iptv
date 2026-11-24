import type { SqlDriver } from '@elv/domain';
import { foldText } from './fold';
import { cleanDisplayTitle } from './title-clean';

/** One candidate live channel inside a {@link SuggestedFailoverCluster} (`#157`). */
export interface SuggestedFailoverClusterMember {
  readonly sourceId: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly sourceName: string;
}

/** Auto-detected cross-source failover cluster spanning at least two distinct sources (`#157`). */
export interface SuggestedFailoverCluster {
  readonly normalizedKey: string;
  readonly suggestedName: string;
  readonly matchReason: 'guide-id' | 'name';
  readonly members: readonly SuggestedFailoverClusterMember[];
}

const QUALITY_AND_CODEC_TOKENS: ReadonlySet<string> = new Set([
  '4k',
  '8k',
  'uhd',
  'fhd',
  'hd',
  'sd',
  'hevc',
  'h265',
  'h264',
  'x265',
  'x264',
  '50fps',
  '60fps',
  'raw',
  'backup',
  'vip',
  '1080p',
  '720p',
  '2160p',
  'hdr',
  'hdr10',
  'ultra',
  'low',
]);

const BRACKET_TAG_RE = /[[(]([^\])]{1,24})[\])]/g;
const H26X_DOT_RE = /\bh\.26([45])\b/gi;
const TWO_LETTER_REGION_RE = /^[a-z]{2}$/i;

function isTagOnlyBracketContent(raw: string): boolean {
  const atoms = raw
    .trim()
    .split(/[\s/+-]+/)
    .filter(Boolean);
  if (atoms.length === 0) return false;
  return atoms.every((atom) => {
    const clean = atom.replace(/\./g, '').toLowerCase();
    return QUALITY_AND_CODEC_TOKENS.has(clean) || TWO_LETTER_REGION_RE.test(atom);
  });
}

function stripTagBrackets(raw: string): string {
  return raw.replace(BRACKET_TAG_RE, (full, inner: string) =>
    isTagOnlyBracketContent(inner) ? ' ' : full,
  );
}

/**
 * Normalizes a live channel display name for cross-source failover auto-clustering (`#157`).
 * Strips region prefixes/brackets (`[TR]`, `US:`, `TR |`), bracketed tags (`(HD)`, `[4K]`),
 * quality/codec/fps tags (`4K`, `UHD`, `FHD`, `HD`, `SD`, `HEVC`, `H265`, `H264`, `50FPS`,
 * `60FPS`, `RAW`, `BACKUP`), and applies Turkish-safe folding.
 */
export function normalizeFailoverChannelName(raw: string): string {
  const cleaned = stripTagBrackets(cleanDisplayTitle(raw)).replace(H26X_DOT_RE, 'h26$1');
  const folded = foldText(cleaned);
  if (folded === '') return '';
  const tokens = folded.split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !QUALITY_AND_CODEC_TOKENS.has(t));
  return (kept.length > 0 ? kept : tokens).join(' ');
}

/** Derives a human-readable failover group name from a member channel title. */
export function cleanSuggestedGroupName(raw: string): string {
  const withoutTags = stripTagBrackets(cleanDisplayTitle(raw))
    .replace(H26X_DOT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = withoutTags.split(' ').filter(Boolean);
  while (words.length > 1) {
    const tail = words[words.length - 1] as string;
    const foldedTail = foldText(tail);
    if (QUALITY_AND_CODEC_TOKENS.has(foldedTail)) {
      words.pop();
    } else {
      break;
    }
  }
  const result = words.join(' ').trim();
  return result.length > 0 ? result : cleanDisplayTitle(raw) || raw.trim();
}

interface RawSuggestRow {
  source_id: string;
  key: string;
  name: string;
  guide_id: string | null;
  source_name: string;
}

function toMember(row: RawSuggestRow): SuggestedFailoverClusterMember {
  return {
    sourceId: row.source_id,
    channelKey: row.key,
    channelName: row.name,
    sourceName: row.source_name,
  };
}

function hasMultipleSources(rows: readonly RawSuggestRow[]): boolean {
  const sources = new Set<string>();
  for (const row of rows) {
    sources.add(row.source_id);
    if (sources.size >= 2) return true;
  }
  return false;
}

/**
 * Queries visible live channels across all ready sources (excluding channels already assigned to
 * any failover group) and returns cross-source failover group suggestions matched by exact
 * trimmed lowercase `guide_id` first, then by {@link normalizeFailoverChannelName} (`#157`).
 */
export async function suggestFailoverGroups(db: SqlDriver): Promise<SuggestedFailoverCluster[]> {
  const rows = await db.all<RawSuggestRow>(
    `SELECT l.source_id, l.key, l.name, l.guide_id, s.name AS source_name
       FROM live l
       INNER JOIN sources s ON s.id = l.source_id AND s.deleting = 0
      WHERE l.is_hidden = 0
        AND NOT EXISTS (
          SELECT 1 FROM failover_group_members m WHERE m.channel_key = l.key
        )
      ORDER BY s.created_at ASC, l.source_id ASC, l.id ASC`,
  );
  if (rows.length < 2) return [];

  const clusters: SuggestedFailoverCluster[] = [];
  const claimedKeys = new Set<string>();

  // Pass 1: exact trimmed lowercase guide_id across >= 2 distinct sources
  const byGuideId = new Map<string, RawSuggestRow[]>();
  for (const row of rows) {
    const trimmedGuide = row.guide_id?.trim().toLowerCase() ?? '';
    if (trimmedGuide === '') continue;
    const bucket = byGuideId.get(trimmedGuide);
    if (bucket === undefined) byGuideId.set(trimmedGuide, [row]);
    else bucket.push(row);
  }
  for (const [guideKey, bucket] of byGuideId) {
    if (!hasMultipleSources(bucket)) continue;
    for (const row of bucket) claimedKeys.add(row.key);
    const first = bucket[0] as RawSuggestRow;
    clusters.push({
      normalizedKey: `guide:${guideKey}`,
      suggestedName: cleanSuggestedGroupName(first.name),
      matchReason: 'guide-id',
      members: bucket.map(toMember),
    });
  }

  // Pass 2: normalized channel name across >= 2 distinct sources (unclaimed rows only)
  const byName = new Map<string, RawSuggestRow[]>();
  for (const row of rows) {
    if (claimedKeys.has(row.key)) continue;
    const normalized = normalizeFailoverChannelName(row.name);
    if (normalized === '') continue;
    const bucket = byName.get(normalized);
    if (bucket === undefined) byName.set(normalized, [row]);
    else bucket.push(row);
  }
  for (const [nameKey, bucket] of byName) {
    if (!hasMultipleSources(bucket)) continue;
    const first = bucket[0] as RawSuggestRow;
    clusters.push({
      normalizedKey: `name:${nameKey}`,
      suggestedName: cleanSuggestedGroupName(first.name),
      matchReason: 'name',
      members: bucket.map(toMember),
    });
  }

  clusters.sort((a, b) => {
    const nameCmp = foldText(a.suggestedName).localeCompare(foldText(b.suggestedName));
    return nameCmp !== 0 ? nameCmp : a.normalizedKey.localeCompare(b.normalizedKey);
  });
  return clusters;
}

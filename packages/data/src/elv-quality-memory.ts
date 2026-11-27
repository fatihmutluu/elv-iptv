import type { ElvEnrichmentStore, ElvQualityMemoryRecord } from './elv-enrichment-repo';

/** Claimed resolution regex matching bounded 4K/UHD/2160p tokens (never `4KIDS`). */
const CLAIMED_4K_RE = /(?<![\p{L}\p{N}])(?:4K|UHD|2160P)(?![\p{L}\p{N}])/iu;

/** Resolution tag regex matching any bounded claimed resolution token (`4K`, `1080p`, `720p`, `HD`, `SD`, etc.). */
const CLAIMED_QUALITY_TAG_RE =
  /(?<![\p{L}\p{N}])(?:8K|4K|UHD|2160P|FHD|1080P|HD|720P|SD|480P|360P)(?![\p{L}\p{N}])/iu;

/** Minimum actual vertical pixels for a stream labeled 4K/UHD/2160p to be considered genuine 4K. */
const FAKE_4K_HEIGHT_THRESHOLD = 1800;

/** Minimum actual horizontal pixels for a cinema-scope stream labeled 4K/UHD/2160p to be considered genuine 4K. */
const REAL_4K_WIDTH_THRESHOLD = 3200;

/** Failure count at or above which a variant is flagged unreliable and ranked strictly at the bottom. */
export const UNRELIABLE_FAIL_COUNT_THRESHOLD = 2;

/** Returns `true` when `label` contains a bounded resolution tag (`4K`, `UHD`, `1080p`, `HD`, etc.). */
export function hasClaimedQualityTag(label: string | null | undefined): boolean {
  return typeof label === 'string' && CLAIMED_QUALITY_TAG_RE.test(label);
}

/** Input payload for {@link recordPlaybackQuality}. */
export interface RecordPlaybackQualityInput {
  readonly itemKey: string;
  readonly actualWidth?: number | null;
  readonly actualHeight?: number | null;
  readonly actualVideoCodec?: string | null;
  readonly actualAudioCodec?: string | null;
  readonly actualAudioChannels?: number | null;
  readonly actualHdr?: string | null;
  readonly claimedLabel?: string | null;
  readonly nowMs?: number;
}

/** Input properties used to compute a deterministic variant quality score. */
export interface ScoreMergedVariantInput {
  readonly verifiedResolution?: string | null;
  readonly actualHeight?: number | null;
  readonly actualVideoCodec?: string | null;
  readonly actualHdr?: string | null;
  readonly claimedQualityRank?: number;
  readonly isFake4k?: boolean;
  readonly failCount?: number;
}

/**
 * Returns `true` when the provider's claimed label advertises `4K`/`UHD`/`2160p`
 * AND the verified playback dimensions are strictly below cinema-scope 4K
 * (`(actualWidth == null || actualWidth < 3200) && actualHeight < 1800`, `#511`).
 */
export function detectFake4k(
  claimedLabel: string | null | undefined,
  actualHeight: number | null | undefined,
  actualWidth?: number | null,
): boolean {
  if (typeof claimedLabel !== 'string' || claimedLabel.trim() === '') return false;
  if (typeof actualHeight !== 'number' || !Number.isFinite(actualHeight) || actualHeight <= 0) {
    return false;
  }
  const hasKnownWidth =
    typeof actualWidth === 'number' && Number.isFinite(actualWidth) && actualWidth > 0;
  return (
    CLAIMED_4K_RE.test(claimedLabel) &&
    (!hasKnownWidth || actualWidth < REAL_4K_WIDTH_THRESHOLD) &&
    actualHeight < FAKE_4K_HEIGHT_THRESHOLD
  );
}

/**
 * Formats verified stream dimensions into a concise resolution tier (`4K`, `1080p`, `720p`, `480p`,
 * or `<height>p`), supporting cinema-scope aspect ratios (`3840x1600`, `1920x800`, `1280x534`)
 * and returning `null` when dimensions are unknown (`#511`).
 */
export function formatVerifiedResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  const w =
    typeof width === 'number' && Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
  const h =
    typeof height === 'number' && Number.isFinite(height) && height > 0 ? Math.round(height) : 0;
  if (w === 0 && h === 0) return null;
  if (h >= 2000 || w >= 3600) return '4K';
  if (h >= 1000 || w >= 1800) return '1080p';
  if (h >= 680 || w >= 1200) return '720p';
  if (h === 0) return null;
  if (h >= 440) return '480p';
  return `${h}p`;
}

function normalizePositiveInt(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

function normalizeText(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Persists verified actual playback video/audio specs into `elv_quality_memory`,
 * flags fake-4K claims, resets `fail_count = 0`, and records `last_success_at` (`#511`).
 */
export async function recordPlaybackQuality(
  store: ElvEnrichmentStore,
  input: RecordPlaybackQualityInput,
): Promise<ElvQualityMemoryRecord> {
  const existing = await store.getQualityMemory(input.itemKey);
  const nowMs = input.nowMs ?? Date.now();
  const actualWidth = normalizePositiveInt(input.actualWidth);
  const actualHeight = normalizePositiveInt(input.actualHeight);
  const claimedLabel = normalizeText(input.claimedLabel) ?? existing?.claimedLabel ?? null;
  const isFake4k = detectFake4k(claimedLabel, actualHeight, actualWidth);

  const record: ElvQualityMemoryRecord = {
    itemKey: input.itemKey,
    actualWidth,
    actualHeight,
    actualVideoCodec: normalizeText(input.actualVideoCodec),
    actualAudioCodec: normalizeText(input.actualAudioCodec),
    actualAudioChannels: normalizePositiveInt(input.actualAudioChannels),
    actualHdr: normalizeText(input.actualHdr),
    claimedLabel,
    isFake4k,
    failCount: 0,
    lastSuccessAt: nowMs,
    lastFailAt: existing?.lastFailAt ?? null,
    updatedAt: nowMs,
  };
  await store.upsertQualityMemory(record);
  return record;
}

/**
 * Increments `fail_count` and updates `last_fail_at` in `elv_quality_memory`
 * while preserving any previously measured resolution/codec metadata (`#511`).
 */
export async function recordPlaybackVariantFailure(
  store: ElvEnrichmentStore,
  itemKey: string,
  nowMs: number = Date.now(),
): Promise<ElvQualityMemoryRecord> {
  const existing = await store.getQualityMemory(itemKey);
  const record: ElvQualityMemoryRecord = {
    itemKey,
    actualWidth: existing?.actualWidth ?? null,
    actualHeight: existing?.actualHeight ?? null,
    actualVideoCodec: existing?.actualVideoCodec ?? null,
    actualAudioCodec: existing?.actualAudioCodec ?? null,
    actualAudioChannels: existing?.actualAudioChannels ?? null,
    actualHdr: existing?.actualHdr ?? null,
    claimedLabel: existing?.claimedLabel ?? null,
    isFake4k: existing?.isFake4k ?? false,
    failCount: (existing?.failCount ?? 0) + 1,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastFailAt: nowMs,
    updatedAt: nowMs,
  };
  await store.upsertQualityMemory(record);
  return record;
}

/**
 * Computes a deterministic preference score for multi-source variants (`#511`):
 * - Verified real 4K (`1000+`) > Verified 1080p (`800+`) > Unverified claimed (`500..580`)
 *   > Verified 720p (`450`) > Verified <=480p (`380`) > Fake-4K (`200..250`).
 * - Unreliable variants (`failCount >= 2`) receive a heavy penalty (`-10_000`) and always sort last.
 */
export function scoreMergedVariant(variant: ScoreMergedVariantInput): number {
  const failCount =
    typeof variant.failCount === 'number' && Number.isFinite(variant.failCount)
      ? Math.max(0, Math.floor(variant.failCount))
      : 0;
  const claimedRank =
    typeof variant.claimedQualityRank === 'number' && Number.isFinite(variant.claimedQualityRank)
      ? Math.max(0, Math.min(80, variant.claimedQualityRank))
      : 15;

  let base: number;
  if (variant.isFake4k === true) {
    const heightTieBreak =
      typeof variant.actualHeight === 'number' && variant.actualHeight > 0
        ? Math.min(50, Math.floor(variant.actualHeight / 40))
        : 0;
    base = 200 + heightTieBreak;
  } else if (variant.verifiedResolution === '4K') {
    base = 1000;
  } else if (variant.verifiedResolution === '1080p') {
    base = 800;
  } else if (variant.verifiedResolution === '720p') {
    base = 450;
  } else if (variant.verifiedResolution !== null && variant.verifiedResolution !== undefined) {
    base = 380;
  } else {
    base = 500 + claimedRank;
  }

  let bonus = 0;
  if (
    variant.isFake4k !== true &&
    variant.verifiedResolution !== null &&
    variant.verifiedResolution !== undefined
  ) {
    if (variant.actualHdr !== null && variant.actualHdr !== undefined && variant.actualHdr !== '') {
      bonus += 10;
    }
    const codec = variant.actualVideoCodec?.toLowerCase() ?? '';
    if (codec.includes('hevc') || codec.includes('h265') || codec.includes('av1')) {
      bonus += 5;
    }
  }

  if (failCount >= UNRELIABLE_FAIL_COUNT_THRESHOLD) {
    return base + bonus - 10_000 - failCount * 100;
  }
  if (failCount === 1) {
    return base + bonus - 25;
  }
  return base + bonus;
}

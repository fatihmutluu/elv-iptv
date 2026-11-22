import type { SqlDriver } from '@elv/domain';
import { SOURCE_ID } from './sources';
import { normalizeProfileId } from './user-state-helpers';

/** Valid persisted per-item video resize modes (`#208`). */
export type TrackPreferenceResizeMode = 'fit' | 'fill' | 'stretch';

/** Persisted per-item track, sync delay, and aspect preference row (`#208`). */
export interface PersistedTrackPreference {
  readonly profileId: string;
  readonly scopeKey: string;
  readonly sourceId: string;
  readonly audioLang: string | null;
  readonly audioLabel: string | null;
  readonly subLang: string | null;
  readonly subLabel: string | null;
  readonly subDisabled: boolean;
  readonly audioDelayMs: number;
  readonly subDelayMs: number;
  readonly resizeMode: TrackPreferenceResizeMode | null;
  readonly updatedAt: number;
}

/** Partial UPSERT payload for {@link saveTrackPreference}. Undefined fields preserve stored values. */
export interface SaveTrackPreferenceInput {
  readonly scopeKey: string;
  readonly sourceId: string;
  readonly profileId?: string;
  readonly audioLang?: string | null;
  readonly audioLabel?: string | null;
  readonly subLang?: string | null;
  readonly subLabel?: string | null;
  readonly subDisabled?: boolean;
  readonly audioDelayMs?: number;
  readonly subDelayMs?: number;
  readonly resizeMode?: TrackPreferenceResizeMode | null;
}

/** @internal Raw SQLite row shape for `track_preferences`. */
export interface RawTrackPreferenceRow {
  profile_id: string;
  scope_key: string;
  source_id: string;
  audio_lang: string | null;
  audio_label: string | null;
  sub_lang: string | null;
  sub_label: string | null;
  sub_disabled: number;
  audio_delay_ms: number;
  sub_delay_ms: number;
  resize_mode: string | null;
  updated_at: number;
}

const MAX_LANG_LENGTH = 16;
const MAX_LABEL_LENGTH = 128;
const MAX_DELAY_MS = 60_000;
const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;
const RESIZE_MODES = new Set<TrackPreferenceResizeMode>(['fit', 'fill', 'stretch']);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** @internal Sanitizes a track language tag (never storing URLs, templates, or credentials). */
export function sanitizeTrackLang(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LANG_LENGTH) return null;
  if (!LANG_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** @internal Sanitizes a track label (never storing URLs, templates, or control characters). */
export function sanitizeTrackLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    hasControlChar(trimmed) ||
    trimmed.includes('://') ||
    trimmed.includes('{{')
  ) {
    return null;
  }
  return trimmed.slice(0, MAX_LABEL_LENGTH);
}

/** @internal Clamps audio/subtitle sync delay in ms to `[-60_000, 60_000]`. */
export function clampTrackDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.min(MAX_DELAY_MS, Math.max(-MAX_DELAY_MS, Math.round(value)));
  return rounded === 0 ? 0 : rounded;
}

/** @internal Validates a resize mode value. */
export function sanitizeResizeMode(value: unknown): TrackPreferenceResizeMode | null {
  if (typeof value !== 'string') return null;
  return RESIZE_MODES.has(value as TrackPreferenceResizeMode)
    ? (value as TrackPreferenceResizeMode)
    : null;
}

/** @internal Maps a raw SQLite `track_preferences` row into a typed {@link PersistedTrackPreference}. */
export function mapTrackPreferenceRow(row: RawTrackPreferenceRow): PersistedTrackPreference {
  return {
    profileId: row.profile_id,
    scopeKey: row.scope_key,
    sourceId: row.source_id,
    audioLang: row.audio_lang,
    audioLabel: row.audio_label,
    subLang: row.sub_lang,
    subLabel: row.sub_label,
    subDisabled: row.sub_disabled !== 0,
    audioDelayMs: row.audio_delay_ms,
    subDelayMs: row.sub_delay_ms,
    resizeMode: sanitizeResizeMode(row.resize_mode),
    updatedAt: row.updated_at,
  };
}

const SELECT_SQL = `SELECT
  profile_id, scope_key, source_id,
  audio_lang, audio_label, sub_lang, sub_label,
  sub_disabled, audio_delay_ms, sub_delay_ms, resize_mode, updated_at
FROM track_preferences
WHERE profile_id = ? AND scope_key = ?`;

const UPSERT_SQL = `INSERT INTO track_preferences (
  profile_id, scope_key, source_id,
  audio_lang, audio_label, sub_lang, sub_label,
  sub_disabled, audio_delay_ms, sub_delay_ms, resize_mode, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(profile_id, scope_key) DO UPDATE SET
  source_id = excluded.source_id,
  audio_lang = CASE WHEN ? THEN excluded.audio_lang ELSE track_preferences.audio_lang END,
  audio_label = CASE WHEN ? THEN excluded.audio_label ELSE track_preferences.audio_label END,
  sub_lang = CASE WHEN ? THEN excluded.sub_lang ELSE track_preferences.sub_lang END,
  sub_label = CASE WHEN ? THEN excluded.sub_label ELSE track_preferences.sub_label END,
  sub_disabled = CASE WHEN ? THEN excluded.sub_disabled ELSE track_preferences.sub_disabled END,
  audio_delay_ms = CASE WHEN ? THEN excluded.audio_delay_ms ELSE track_preferences.audio_delay_ms END,
  sub_delay_ms = CASE WHEN ? THEN excluded.sub_delay_ms ELSE track_preferences.sub_delay_ms END,
  resize_mode = CASE WHEN ? THEN excluded.resize_mode ELSE track_preferences.resize_mode END,
  updated_at = excluded.updated_at`;

/** Reads the persisted track preference for `(profileId, scopeKey)`, or `null` if none exists. */
export async function getTrackPreference(
  db: SqlDriver,
  scopeKey: string,
  profileId?: string,
): Promise<PersistedTrackPreference | null> {
  const key = scopeKey.trim();
  if (key.length === 0) return null;
  const profile = normalizeProfileId(profileId);
  const rows = await db.all<RawTrackPreferenceRow>(SELECT_SQL, [profile, key]);
  const row = rows[0];
  return row === undefined ? null : mapTrackPreferenceRow(row);
}

/**
 * Persists or merges per-item track, sync delay, and resize preferences via parameterized UPSERT.
 * Omitted (`undefined`) fields preserve their existing stored values; explicit `null` clears them.
 */
export async function saveTrackPreference(
  db: SqlDriver,
  input: SaveTrackPreferenceInput,
  clock: () => number = Date.now,
): Promise<void> {
  const scopeKey = input.scopeKey.trim();
  if (scopeKey.length === 0 || !SOURCE_ID.test(input.sourceId)) return;
  const profileId = normalizeProfileId(input.profileId);

  const hasAudioLang = input.audioLang !== undefined ? 1 : 0;
  const hasAudioLabel = input.audioLabel !== undefined ? 1 : 0;
  const hasSubLang = input.subLang !== undefined ? 1 : 0;
  const hasSubLabel = input.subLabel !== undefined ? 1 : 0;
  const hasSubDisabled = input.subDisabled !== undefined ? 1 : 0;
  const hasAudioDelay = input.audioDelayMs !== undefined ? 1 : 0;
  const hasSubDelay = input.subDelayMs !== undefined ? 1 : 0;
  const hasResizeMode = input.resizeMode !== undefined ? 1 : 0;

  const audioLang = hasAudioLang ? sanitizeTrackLang(input.audioLang) : null;
  const audioLabel = hasAudioLabel ? sanitizeTrackLabel(input.audioLabel) : null;
  const subLang = hasSubLang ? sanitizeTrackLang(input.subLang) : null;
  const subLabel = hasSubLabel ? sanitizeTrackLabel(input.subLabel) : null;
  const subDisabled = input.subDisabled === true ? 1 : 0;
  const audioDelayMs = hasAudioDelay ? clampTrackDelayMs(input.audioDelayMs) : 0;
  const subDelayMs = hasSubDelay ? clampTrackDelayMs(input.subDelayMs) : 0;
  const resizeMode = hasResizeMode ? sanitizeResizeMode(input.resizeMode) : null;
  const updatedAt = Math.round(clock());

  await db.run(UPSERT_SQL, [
    profileId,
    scopeKey,
    input.sourceId,
    audioLang,
    audioLabel,
    subLang,
    subLabel,
    subDisabled,
    audioDelayMs,
    subDelayMs,
    resizeMode,
    updatedAt,
    hasAudioLang,
    hasAudioLabel,
    hasSubLang,
    hasSubLabel,
    hasSubDisabled,
    hasAudioDelay,
    hasSubDelay,
    hasResizeMode,
  ]);
}

/** Deletes the persisted track preference for `(profileId, scopeKey)`. */
export async function clearTrackPreference(
  db: SqlDriver,
  scopeKey: string,
  profileId?: string,
): Promise<void> {
  const key = scopeKey.trim();
  if (key.length === 0) return;
  const profile = normalizeProfileId(profileId);
  await db.run('DELETE FROM track_preferences WHERE profile_id = ? AND scope_key = ?', [
    profile,
    key,
  ]);
}

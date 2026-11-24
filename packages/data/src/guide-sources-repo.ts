import { elvError, err, ok, type Result, type SecretStore, type SqlDriver } from '@elv/domain';
import { foldText } from './fold';
import { placeholderNames } from './m3u-templating';
import { isSafeRecentChannelKey } from './recent-channels-repo';
import { sourceExists } from './runs';
import { escapeLikePattern } from './search-channel-overrides';
import { guideSecret, SOURCE_ID } from './sources';
import { readUrlVars, writeUrlVars } from './urlvars-store';

/** Maximum trimmed length of a guide source display name (`#30`). */
export const MAX_GUIDE_SOURCE_NAME_LENGTH = 80;

/** Maximum absolute per-guide or per-channel EPG time shift (12 hours, `#30`). */
export const MAX_EPG_SHIFT_MS = 12 * 3_600_000;

/** Default page cap for {@link listGuideChannels}. */
export const DEFAULT_GUIDE_CHANNELS_LIMIT = 100;

/** Hard upper bound for {@link listGuideChannels}. */
export const MAX_GUIDE_CHANNELS_LIMIT = 500;

const GUIDE_SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_GUIDE_VAR_RE = /^(?:url|d\d+)$/;
const MAX_GUIDE_URL_LENGTH = 4_096;

/** A configured priority-ordered XMLTV guide source row (`#30`). */
export interface GuideSourceRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly priority: number;
  readonly name: string;
  /** Secret placeholder `{{g:<guideId>}}`; the raw URL lives strictly in `SecretStore`. */
  readonly urlTemplate: string;
  readonly epgShiftMs: number;
  readonly enabled: boolean;
  readonly lastSyncAt: number | null;
}

/** Input for {@link addGuideSource}. */
export interface AddGuideSourceInput {
  readonly sourceId: string;
  readonly name: string;
  readonly url: string;
  readonly priority?: number;
  readonly epgShiftMs?: number;
  readonly enabled?: boolean;
}

/** Partial update patch for {@link updateGuideSource}. */
export interface UpdateGuideSourcePatch {
  readonly name?: string;
  readonly url?: string;
  readonly priority?: number;
  readonly epgShiftMs?: number;
  readonly enabled?: boolean;
}

/** An available XMLTV `<channel>` option returned by {@link listGuideChannels}. */
export interface GuideChannelOption {
  readonly guideId: string;
  readonly name: string;
  readonly icon: string | null;
  readonly lcn: string | null;
  /** Originating `guide_sources.id` when known, preserving per-guide `epg_shift_ms` on manual overrides (`#30`). */
  readonly guideSourceId?: string | null;
}

/** A Tier-0 manual channel-to-guide override row from `channel_guide_overrides` (`#30`). */
export interface ChannelGuideOverrideRecord {
  readonly sourceId: string;
  readonly channelKey: string;
  readonly guideSourceId: string | null;
  readonly guideId: string | null;
  readonly epgShiftMs: number;
  readonly isManual: boolean;
  readonly updatedAt: number;
}

/** Input for {@link setChannelGuideOverride}. */
export interface SetChannelGuideOverrideInput {
  readonly sourceId: string;
  readonly channelKey: string;
  readonly guideSourceId?: string | null;
  readonly guideId?: string | null;
  readonly epgShiftMs?: number;
}

/** @internal Raw `guide_sources` row including `http_cache_json` for ingestion. */
export interface RawGuideSourceRow {
  id: string;
  source_id: string;
  priority: number;
  name: string;
  url_template: string;
  epg_shift_ms: number;
  enabled: number;
  last_sync_at: number | null;
  http_cache_json: string | null;
}

interface RawChannelGuideOverrideRow {
  source_id: string;
  channel_key: string;
  guide_source_id: string | null;
  guide_id: string | null;
  epg_shift_ms: number;
  is_manual: number;
  updated_at: number;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateGuideUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_GUIDE_URL_LENGTH ||
    hasControlChar(trimmed) ||
    /\s/.test(trimmed)
  ) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.hostname.length === 0
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return trimmed;
}

function validateGuideName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_GUIDE_SOURCE_NAME_LENGTH) return null;
  if (hasControlChar(trimmed)) return null;
  return trimmed;
}

function normalizeEpgShiftMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(-MAX_EPG_SHIFT_MS, Math.min(MAX_EPG_SHIFT_MS, Math.round(raw)));
}

function defaultGuideSourceId(clock: () => number): string {
  const ts = Math.max(0, Math.floor(clock())).toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return `gs_${ts}_${rand}`;
}

function mapGuideSourceRow(row: RawGuideSourceRow): GuideSourceRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    priority: row.priority,
    name: row.name,
    urlTemplate: row.url_template,
    epgShiftMs: row.epg_shift_ms,
    enabled: row.enabled !== 0,
    lastSyncAt: row.last_sync_at,
  };
}

function mapChannelGuideOverrideRow(row: RawChannelGuideOverrideRow): ChannelGuideOverrideRecord {
  return {
    sourceId: row.source_id,
    channelKey: row.channel_key,
    guideSourceId: row.guide_source_id,
    guideId: row.guide_id,
    epgShiftMs: row.epg_shift_ms,
    isManual: row.is_manual !== 0,
    updatedAt: row.updated_at,
  };
}

function secretVarNameFromTemplate(template: string, fallbackId: string): string {
  const first = placeholderNames(template)[0];
  if (first?.startsWith('g:')) return first;
  return `g:${fallbackId}`;
}

/** Lists all configured guide sources for `sourceId` ordered by ascending `priority`, then `id`. */
export async function listGuideSources(
  db: SqlDriver,
  sourceId: string,
): Promise<GuideSourceRecord[]> {
  if (!SOURCE_ID.test(sourceId)) return [];
  const rows = await db.all<RawGuideSourceRow>(
    `SELECT id, source_id, priority, name, url_template, epg_shift_ms, enabled, last_sync_at, http_cache_json
       FROM guide_sources
      WHERE source_id = ?
      ORDER BY priority ASC, id ASC`,
    [sourceId],
  );
  return rows.map(mapGuideSourceRow);
}

/** @internal Lists enabled `guide_sources` rows (including `http_cache_json`) in priority order for `importGuide`. */
export async function listEnabledGuideSourcesRaw(
  db: SqlDriver,
  sourceId: string,
): Promise<RawGuideSourceRow[]> {
  return db.all<RawGuideSourceRow>(
    `SELECT id, source_id, priority, name, url_template, epg_shift_ms, enabled, last_sync_at, http_cache_json
       FROM guide_sources
      WHERE source_id = ? AND enabled = 1
      ORDER BY priority ASC, id ASC`,
    [sourceId],
  );
}

/**
 * Adds a new XMLTV guide source for `input.sourceId` (`#30`). Stores the raw guide URL strictly as
 * `{{g:<guideId>}}` in `SecretStore` (`urlvars`) so credentials and tokens never enter SQLite.
 */
export async function addGuideSource(
  db: SqlDriver,
  secrets: SecretStore,
  input: AddGuideSourceInput,
  clock: () => number = Date.now,
  newId?: () => string,
): Promise<Result<GuideSourceRecord>> {
  if (!SOURCE_ID.test(input.sourceId)) return err(elvError('storage', 'source-not-found'));
  const name = validateGuideName(input.name);
  if (name === null) return err(elvError('source-format', 'invalid-guide-source'));
  const url = validateGuideUrl(input.url);
  if (url === null) return err(elvError('source-format', 'invalid-guide-url'));
  if (!(await sourceExists(db, input.sourceId))) {
    return err(elvError('storage', 'source-not-found'));
  }

  const id = newId !== undefined ? newId() : defaultGuideSourceId(clock);
  if (!GUIDE_SOURCE_ID_RE.test(id) || RESERVED_GUIDE_VAR_RE.test(id)) {
    return err(elvError('storage', 'invalid-guide-source-id'));
  }

  const secret = guideSecret(url, id);
  const existingVars = await readUrlVars({ secrets }, input.sourceId);
  const nextVars = { ...existingVars, ...secret.vars };
  const secretSaved = await writeUrlVars(secrets, input.sourceId, nextVars);
  if (!secretSaved.ok) return secretSaved;

  const existingRows = await db.all<{ max_p: number | null }>(
    'SELECT MAX(priority) AS max_p FROM guide_sources WHERE source_id = ?',
    [input.sourceId],
  );
  const nextPriority =
    typeof input.priority === 'number' && Number.isFinite(input.priority)
      ? Math.max(0, Math.floor(input.priority))
      : existingRows[0]?.max_p === null || existingRows[0]?.max_p === undefined
        ? 0
        : existingRows[0].max_p + 1;
  const epgShiftMs = normalizeEpgShiftMs(input.epgShiftMs);
  const enabled = input.enabled !== false;

  try {
    await db.run(
      `INSERT INTO guide_sources (id, source_id, priority, name, url_template, epg_shift_ms, enabled, last_sync_at, http_cache_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [id, input.sourceId, nextPriority, name, secret.template, epgShiftMs, enabled ? 1 : 0],
    );
  } catch {
    await writeUrlVars(secrets, input.sourceId, existingVars).catch(() => undefined);
    return err(elvError('storage', 'guide-source-write-failed'));
  }

  return ok({
    id,
    sourceId: input.sourceId,
    priority: nextPriority,
    name,
    urlTemplate: secret.template,
    epgShiftMs,
    enabled,
    lastSyncAt: null,
  });
}

/** Updates a configured guide source's name, secret-backed URL, priority, EPG shift, or enabled flag. */
export async function updateGuideSource(
  db: SqlDriver,
  secrets: SecretStore,
  id: string,
  patch: UpdateGuideSourcePatch,
): Promise<Result<GuideSourceRecord>> {
  if (!GUIDE_SOURCE_ID_RE.test(id)) {
    return err(elvError('storage', 'guide-source-not-found'));
  }
  const rows = await db.all<RawGuideSourceRow>(
    `SELECT id, source_id, priority, name, url_template, epg_shift_ms, enabled, last_sync_at, http_cache_json
       FROM guide_sources
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  const existing = rows[0];
  if (existing === undefined) {
    return err(elvError('storage', 'guide-source-not-found'));
  }

  let nextName = existing.name;
  if (patch.name !== undefined) {
    const valid = validateGuideName(patch.name);
    if (valid === null) return err(elvError('source-format', 'invalid-guide-source'));
    nextName = valid;
  }

  let nextUrl: string | undefined;
  if (patch.url !== undefined) {
    const valid = validateGuideUrl(patch.url);
    if (valid === null) return err(elvError('source-format', 'invalid-guide-url'));
    nextUrl = valid;
  }

  const nextPriority =
    patch.priority !== undefined && Number.isFinite(patch.priority)
      ? Math.max(0, Math.floor(patch.priority))
      : existing.priority;
  const nextShift =
    patch.epgShiftMs !== undefined ? normalizeEpgShiftMs(patch.epgShiftMs) : existing.epg_shift_ms;
  const nextEnabled = patch.enabled !== undefined ? patch.enabled : existing.enabled !== 0;

  let prevVars: Record<string, string> | undefined;
  if (nextUrl !== undefined) {
    const varName = secretVarNameFromTemplate(existing.url_template, existing.id);
    prevVars = await readUrlVars({ secrets }, existing.source_id);
    const saved = await writeUrlVars(secrets, existing.source_id, {
      ...prevVars,
      [varName]: nextUrl,
    });
    if (!saved.ok) return saved;
  }

  try {
    await db.run(
      `UPDATE guide_sources
          SET name = ?, priority = ?, epg_shift_ms = ?, enabled = ?,
              http_cache_json = CASE WHEN ? = 1 THEN NULL ELSE http_cache_json END
        WHERE id = ?`,
      [nextName, nextPriority, nextShift, nextEnabled ? 1 : 0, nextUrl !== undefined ? 1 : 0, id],
    );
  } catch {
    if (prevVars !== undefined) {
      await writeUrlVars(secrets, existing.source_id, prevVars).catch(() => undefined);
    }
    return err(elvError('storage', 'guide-source-write-failed'));
  }

  return ok({
    id: existing.id,
    sourceId: existing.source_id,
    priority: nextPriority,
    name: nextName,
    urlTemplate: existing.url_template,
    epgShiftMs: nextShift,
    enabled: nextEnabled,
    lastSyncAt: existing.last_sync_at,
  });
}

/** Removes a configured guide source, clears its secret from `urlvars`, and cleans up guide-source references. */
export async function removeGuideSource(
  db: SqlDriver,
  secrets: SecretStore,
  id: string,
): Promise<Result<void>> {
  if (!GUIDE_SOURCE_ID_RE.test(id)) {
    return err(elvError('storage', 'guide-source-not-found'));
  }
  const rows = await db.all<RawGuideSourceRow>(
    `SELECT id, source_id, priority, name, url_template, epg_shift_ms, enabled, last_sync_at, http_cache_json
       FROM guide_sources
      WHERE id = ?
      LIMIT 1`,
    [id],
  );
  const existing = rows[0];
  if (existing === undefined) {
    return err(elvError('storage', 'guide-source-not-found'));
  }

  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM guide_sources WHERE id = ?', [id]);
    await tx.run(
      'UPDATE channel_guide_overrides SET guide_source_id = NULL WHERE source_id = ? AND guide_source_id = ? AND is_manual = 1',
      [existing.source_id, id],
    );
    await tx.run(
      'DELETE FROM channel_guide_overrides WHERE source_id = ? AND guide_source_id = ? AND is_manual = 0',
      [existing.source_id, id],
    );
  });

  const varName = secretVarNameFromTemplate(existing.url_template, existing.id);
  const vars = await readUrlVars({ secrets }, existing.source_id);
  if (Object.hasOwn(vars, varName)) {
    const nextVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (k !== varName) nextVars[k] = v;
    }
    await writeUrlVars(secrets, existing.source_id, nextVars).catch(() => undefined);
  }
  return ok(undefined);
}

/** Atomically updates `priority` (`0..N-1`) for all guide sources belonging to `sourceId`. */
export async function reorderGuideSources(
  db: SqlDriver,
  sourceId: string,
  orderedIds: readonly string[],
): Promise<Result<void>> {
  if (!SOURCE_ID.test(sourceId) || !(await sourceExists(db, sourceId))) {
    return err(elvError('storage', 'source-not-found'));
  }
  const existing = await db.all<{ id: string }>(
    'SELECT id FROM guide_sources WHERE source_id = ? ORDER BY priority ASC, id ASC',
    [sourceId],
  );
  const knownIds = new Set(existing.map((r) => r.id));
  const finalOrder: string[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (knownIds.has(id) && !seen.has(id)) {
      seen.add(id);
      finalOrder.push(id);
    }
  }
  for (const row of existing) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      finalOrder.push(row.id);
    }
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < finalOrder.length; i += 1) {
      await tx.run('UPDATE guide_sources SET priority = ? WHERE source_id = ? AND id = ?', [
        i,
        sourceId,
        finalOrder[i] as string,
      ]);
    }
  });
  return ok(undefined);
}

const GUIDE_CHANNEL_SOURCE_EXPR = `COALESCE(
  (SELECT cgo.guide_source_id
     FROM channel_guide_overrides cgo
    WHERE cgo.source_id = gc.source_id
      AND cgo.guide_id = gc.guide_id
      AND cgo.guide_source_id IS NOT NULL
    ORDER BY cgo.is_manual ASC, cgo.updated_at DESC
    LIMIT 1),
  (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(gs.id) ELSE NULL END
     FROM guide_sources gs
    WHERE gs.source_id = gc.source_id AND gs.enabled = 1)
)`;

/** Lists searchable XMLTV guide channels stored for `sourceId` for the Manual Channel Mapper (`#30`). */
export async function listGuideChannels(
  db: SqlDriver,
  sourceId: string,
  query?: string,
  limit: number = DEFAULT_GUIDE_CHANNELS_LIMIT,
): Promise<GuideChannelOption[]> {
  if (!SOURCE_ID.test(sourceId)) return [];
  const clamped = Number.isFinite(limit)
    ? Math.min(MAX_GUIDE_CHANNELS_LIMIT, Math.max(0, Math.floor(limit)))
    : DEFAULT_GUIDE_CHANNELS_LIMIT;
  if (clamped === 0) return [];

  const trimmed = query?.trim() ?? '';
  if (trimmed === '') {
    const rows = await db.all<{
      guide_id: string;
      name: string;
      icon: string | null;
      lcn: string | null;
      guide_source_id: string | null;
    }>(
      `SELECT gc.guide_id, gc.name, gc.icon, gc.lcn,
              ${GUIDE_CHANNEL_SOURCE_EXPR} AS guide_source_id
         FROM guide_channels gc
        WHERE gc.source_id = ?
        ORDER BY gc.name_fold ASC, gc.guide_id ASC
        LIMIT ?`,
      [sourceId, clamped],
    );
    return rows.map((r) => ({
      guideId: r.guide_id,
      name: r.name,
      icon: r.icon,
      lcn: r.lcn,
      guideSourceId: r.guide_source_id,
    }));
  }

  const folded = foldText(trimmed);
  const rawLower = trimmed.toLowerCase();
  const tokens = folded.length > 0 ? folded.split(/\s+/).filter(Boolean).slice(0, 6) : [rawLower];
  const clauses = tokens
    .map(() => "(gc.name_fold LIKE ? ESCAPE '\\' OR LOWER(gc.guide_id) LIKE ? ESCAPE '\\')")
    .join(' AND ');
  const params: (string | number)[] = [sourceId];
  for (const tok of tokens) {
    const pat = `%${escapeLikePattern(tok)}%`;
    params.push(pat, pat);
  }
  params.push(clamped);

  const rows = await db.all<{
    guide_id: string;
    name: string;
    icon: string | null;
    lcn: string | null;
    guide_source_id: string | null;
  }>(
    `SELECT gc.guide_id, gc.name, gc.icon, gc.lcn,
            ${GUIDE_CHANNEL_SOURCE_EXPR} AS guide_source_id
       FROM guide_channels gc
      WHERE gc.source_id = ? AND ${clauses}
      ORDER BY gc.name_fold ASC, gc.guide_id ASC
      LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    guideId: r.guide_id,
    name: r.name,
    icon: r.icon,
    lcn: r.lcn,
    guideSourceId: r.guide_source_id,
  }));
}

/** Lists all manual (`is_manual = 1`) channel-to-guide overrides for `sourceId` (`#30`). */
export async function listChannelGuideOverrides(
  db: SqlDriver,
  sourceId: string,
): Promise<ChannelGuideOverrideRecord[]> {
  if (!SOURCE_ID.test(sourceId)) return [];
  const rows = await db.all<RawChannelGuideOverrideRow>(
    `SELECT source_id, channel_key, guide_source_id, guide_id, epg_shift_ms, is_manual, updated_at
       FROM channel_guide_overrides
      WHERE source_id = ? AND is_manual = 1
      ORDER BY channel_key ASC`,
    [sourceId],
  );
  return rows.map(mapChannelGuideOverrideRow);
}

/**
 * Sets or updates a Tier-0 manual channel-to-guide override and/or per-channel EPG time offset (`#30`).
 * Immediately updates `channel_guide` when `guideId` is provided so EPG queries reflect the mapping right away.
 */
export async function setChannelGuideOverride(
  db: SqlDriver,
  input: SetChannelGuideOverrideInput,
  clock: () => number = Date.now,
): Promise<Result<ChannelGuideOverrideRecord>> {
  if (!SOURCE_ID.test(input.sourceId)) {
    return err(elvError('storage', 'source-not-found'));
  }
  if (!isSafeRecentChannelKey(input.channelKey)) {
    return err(elvError('source-format', 'invalid-channel-key'));
  }
  const channelKey = input.channelKey.trim();
  const guideId =
    input.guideId === undefined || input.guideId === null || input.guideId.trim() === ''
      ? null
      : input.guideId.trim();
  if (guideId !== null && (hasControlChar(guideId) || guideId.length > 256)) {
    return err(elvError('source-format', 'invalid-guide-id'));
  }
  const preserveGuideSourceId = input.guideSourceId === undefined;
  const guideSourceId =
    input.guideSourceId === undefined ||
    input.guideSourceId === null ||
    input.guideSourceId.trim() === ''
      ? null
      : input.guideSourceId.trim();
  if (guideSourceId !== null && !GUIDE_SOURCE_ID_RE.test(guideSourceId)) {
    return err(elvError('source-format', 'invalid-guide-source-id'));
  }
  const epgShiftMs = normalizeEpgShiftMs(input.epgShiftMs);
  const now = Math.max(0, Math.round(clock()));

  const savedRow = await db.transaction(async (tx) => {
    if (!(await sourceExists(tx, input.sourceId))) return undefined;
    const guideSourceUpdateExpr = preserveGuideSourceId
      ? 'COALESCE(excluded.guide_source_id, channel_guide_overrides.guide_source_id)'
      : 'excluded.guide_source_id';
    await tx.run(
      `INSERT INTO channel_guide_overrides (source_id, channel_key, guide_source_id, guide_id, epg_shift_ms, is_manual, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(source_id, channel_key) DO UPDATE SET
         guide_source_id = ${guideSourceUpdateExpr},
         guide_id = excluded.guide_id,
         epg_shift_ms = excluded.epg_shift_ms,
         is_manual = 1,
         updated_at = excluded.updated_at`,
      [input.sourceId, channelKey, guideSourceId, guideId, epgShiftMs, now],
    );
    if (guideId !== null) {
      await tx.run(
        `INSERT INTO channel_guide (source_id, channel_key, guide_id)
         VALUES (?, ?, ?)
         ON CONFLICT(source_id, channel_key) DO UPDATE SET guide_id = excluded.guide_id`,
        [input.sourceId, channelKey, guideId],
      );
    }
    const rows = await tx.all<RawChannelGuideOverrideRow>(
      `SELECT source_id, channel_key, guide_source_id, guide_id, epg_shift_ms, is_manual, updated_at
         FROM channel_guide_overrides
        WHERE source_id = ? AND channel_key = ?
        LIMIT 1`,
      [input.sourceId, channelKey],
    );
    return rows[0];
  });

  if (savedRow === undefined) return err(elvError('storage', 'source-not-found'));
  return ok(mapChannelGuideOverrideRow(savedRow));
}

/** Removes any manual channel-to-guide override for `(sourceId, channelKey)`, clears stale `channel_guide` state, and restores automatic `live.guide_id` mapping if present. */
export async function clearChannelGuideOverride(
  db: SqlDriver,
  sourceId: string,
  channelKey: string,
): Promise<Result<void>> {
  if (!SOURCE_ID.test(sourceId) || !isSafeRecentChannelKey(channelKey)) {
    return ok(undefined);
  }
  const trimmedKey = channelKey.trim();
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM channel_guide_overrides WHERE source_id = ? AND channel_key = ?', [
      sourceId,
      trimmedKey,
    ]);
    await tx.run('DELETE FROM channel_guide WHERE source_id = ? AND channel_key = ?', [
      sourceId,
      trimmedKey,
    ]);
    const liveRows = await tx.all<{ guide_id: string | null }>(
      `SELECT l.guide_id
         FROM live l
         JOIN guide_channels gc
           ON gc.source_id = l.source_id AND gc.guide_id = l.guide_id
        WHERE l.source_id = ? AND l.key = ? AND l.guide_id IS NOT NULL AND l.guide_id != ''
        LIMIT 1`,
      [sourceId, trimmedKey],
    );
    const autoGuideId = liveRows[0]?.guide_id;
    if (autoGuideId !== undefined && autoGuideId !== null && autoGuideId !== '') {
      await tx.run(
        `INSERT OR IGNORE INTO channel_guide (source_id, channel_key, guide_id)
         VALUES (?, ?, ?)`,
        [sourceId, trimmedKey, autoGuideId],
      );
    }
  });
  return ok(undefined);
}

/**
 * Migration v16 (`#220`, `#306`, `#27`, `#30`, `#35`):
 * - Adds `catchup_mode` and `catchup_source_template` columns to `live` and `live_next` for
 *   credential-free M3U/Xtream catch-up persistence and play-time URL resolution.
 * - Adds `guide_sources` (`idx_guide_sources_source`) storing priority-ordered XMLTV guide
 *   definitions with secret-backed `{{g:<guideId>}}` URL placeholders and per-guide time shifts.
 * - Adds `channel_guide_overrides` (`WITHOUT ROWID`) storing Tier-0 manual channel-to-guide
 *   overrides (`is_manual = 1`), per-channel EPG time shifts, and multi-guide source attributions.
 * - Adds `programme_reminders` (`WITHOUT ROWID`, `idx_programme_reminders_due`,
 *   `idx_programme_reminders_source`) storing per-profile scheduled programme reminders.
 */
export const MIGRATION_V16 = `
ALTER TABLE live ADD COLUMN catchup_mode TEXT;
ALTER TABLE live ADD COLUMN catchup_source_template TEXT;
ALTER TABLE live_next ADD COLUMN catchup_mode TEXT;
ALTER TABLE live_next ADD COLUMN catchup_source_template TEXT;

CREATE TABLE IF NOT EXISTS guide_sources (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  url_template TEXT NOT NULL,
  epg_shift_ms INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER,
  http_cache_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_guide_sources_source ON guide_sources (source_id, priority);

CREATE TABLE IF NOT EXISTS channel_guide_overrides (
  source_id TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  guide_source_id TEXT,
  guide_id TEXT,
  epg_shift_ms INTEGER NOT NULL DEFAULT 0,
  is_manual INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, channel_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS programme_reminders (
  profile_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  programme_title TEXT NOT NULL,
  programme_start INTEGER NOT NULL,
  programme_stop INTEGER NOT NULL,
  lead_time_ms INTEGER NOT NULL DEFAULT 300000,
  fired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, channel_key, programme_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_programme_reminders_due ON programme_reminders (profile_id, fired, programme_start);
CREATE INDEX IF NOT EXISTS idx_programme_reminders_source ON programme_reminders (source_id);
`;

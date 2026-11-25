-- Initial schema for ELV IPTV self-hostable E2EE sync and opt-in telemetry backend.
-- Compatible with Cloudflare D1 (SQLite).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  verifier_hash TEXT NOT NULL,
  verifier_salt TEXT NOT NULL,
  verifier_iterations INTEGER NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  wrapped_vault_key TEXT NOT NULL,
  recovery_wrapped_vault_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  replaced_by_id TEXT,
  revoked_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS vaults (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  poll_token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by_user_id TEXT,
  encrypted_payload TEXT,
  iv TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pair_sessions_code ON pair_sessions(code);
CREATE INDEX IF NOT EXISTS idx_pair_sessions_expires_at ON pair_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pair_sessions_claimed_user ON pair_sessions(claimed_by_user_id);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  event_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  os_version TEXT,
  form_factor TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_received_at ON telemetry_events(received_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_kind ON telemetry_events(kind);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_version_platform ON telemetry_events(app_version, platform);

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  locale TEXT,
  diagnostics_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_received_at ON feedback_submissions(received_at);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_category ON feedback_submissions(category);

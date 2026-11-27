-- Wave P9 (#509, #510): Bidirectional 8-digit X25519 pairing + telemetry device profile.
-- Compatible with Cloudflare D1 (SQLite), applied after 0001_init.sql.
-- Note: `pair_sessions.status TEXT NOT NULL` and `pair_sessions.code TEXT NOT NULL UNIQUE`
-- already exist from 0001_init.sql (`code` stores sha256(code) hex so raw codes are never at rest).

ALTER TABLE pair_sessions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pair_sessions ADD COLUMN host_public_key TEXT;
ALTER TABLE pair_sessions ADD COLUMN responder_public_key TEXT;
ALTER TABLE pair_sessions ADD COLUMN host_auth_state TEXT NOT NULL DEFAULT 'signed_out';
ALTER TABLE pair_sessions ADD COLUMN host_masked_email TEXT;
ALTER TABLE pair_sessions ADD COLUMN host_email_hash TEXT;
ALTER TABLE pair_sessions ADD COLUMN responder_auth_state TEXT;
ALTER TABLE pair_sessions ADD COLUMN responder_masked_email TEXT;
ALTER TABLE pair_sessions ADD COLUMN responder_email_hash TEXT;
ALTER TABLE pair_sessions ADD COLUMN responder_token_hash TEXT;
ALTER TABLE pair_sessions ADD COLUMN direction TEXT;
ALTER TABLE pair_sessions ADD COLUMN host_approved_at INTEGER;
ALTER TABLE pair_sessions ADD COLUMN return_encrypted_payload TEXT;
ALTER TABLE pair_sessions ADD COLUMN return_iv TEXT;

CREATE INDEX IF NOT EXISTS idx_pair_sessions_responder_token_hash ON pair_sessions(responder_token_hash);

ALTER TABLE telemetry_events ADD COLUMN device_profile_json TEXT;

import { elvError, err, ok, type Result, type SecretStore, type SqlDriver } from '@elv/domain';
import { DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN, pinSecretKey } from './parental-policy';
import { markParentalStateDirty, refreshParentalFastPath } from './parental-repo';
import { DEFAULT_PROFILE_ID } from './user-state-helpers';

/** Built-in profile avatar palette tokens rendered by `@elv/features` without hardcoded hex values (`#15`). */
export const PROFILE_AVATAR_TOKENS = [
  'crimson',
  'sapphire',
  'amber',
  'violet',
  'emerald',
  'slate',
  'coral',
  'teal',
  'indigo',
] as const;

/** Allowed avatar color token for a local profile. */
export type ProfileAvatarToken = (typeof PROFILE_AVATAR_TOKENS)[number];

/** Maximum trimmed character length of a profile display name. */
export const MAX_PROFILE_NAME_LENGTH = 40;

/** Strict safe profile ID regex compatible with SQLite, SecureStore, Electron IPC, and Preferences KV. */
export const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const AVATAR_TOKEN_SET = new Set<string>(PROFILE_AVATAR_TOKENS);

/** A local profile row from the `profiles` table (`#15`). */
export interface ProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly avatarToken: ProfileAvatarToken;
  readonly isKids: boolean;
  readonly isDefault: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input for {@link createProfile}. */
export interface CreateProfileInput {
  readonly name: string;
  readonly avatarToken?: ProfileAvatarToken;
  readonly isKids?: boolean;
}

/** Partial update patch for {@link updateProfile}. */
export interface UpdateProfilePatch {
  readonly name?: string;
  readonly avatarToken?: ProfileAvatarToken;
  readonly isKids?: boolean;
}

interface RawProfileRow {
  id: string;
  name: string;
  avatar_token: string;
  is_kids: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

/** Type guard verifying a safe profile ID matching {@link PROFILE_ID_RE}. */
export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && PROFILE_ID_RE.test(id);
}

/** Type guard verifying a supported {@link ProfileAvatarToken}. */
export function isProfileAvatarToken(value: unknown): value is ProfileAvatarToken {
  return typeof value === 'string' && AVATAR_TOKEN_SET.has(value);
}

function normalizeAvatarToken(raw: string): ProfileAvatarToken {
  return isProfileAvatarToken(raw) ? raw : 'crimson';
}

function mapProfileRow(row: RawProfileRow): ProfileRecord {
  return {
    id: row.id,
    name: row.name,
    avatarToken: normalizeAvatarToken(row.avatar_token),
    isKids: row.is_kids !== 0,
    isDefault: row.is_default !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateProfileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROFILE_NAME_LENGTH) return null;
  return trimmed;
}

function defaultProfileId(clock: () => number): string {
  const ts = Math.max(0, Math.floor(clock())).toString(36);
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return `p_${ts}_${rand}`;
}

const LIST_PROFILES_SQL = `SELECT id, name, avatar_token, is_kids, is_default, created_at, updated_at
  FROM profiles
 ORDER BY is_default DESC, created_at ASC, id ASC`;

/**
 * Lists all local profiles ordered default-first, then creation order.
 * Auto-seeds the `'default'` profile if the `profiles` table is unexpectedly empty.
 */
export async function listProfiles(db: SqlDriver): Promise<ProfileRecord[]> {
  let rows = await db.all<RawProfileRow>(LIST_PROFILES_SQL);
  if (rows.length === 0) {
    await db.run(
      `INSERT OR IGNORE INTO profiles (id, name, avatar_token, is_kids, is_default, created_at, updated_at)
       VALUES (?, 'Default', 'crimson', 0, 1, 0, 0)`,
      [DEFAULT_PROFILE_ID],
    );
    rows = await db.all<RawProfileRow>(LIST_PROFILES_SQL);
  }
  return rows.map(mapProfileRow);
}

/**
 * Creates a new local profile (`#15`). When `isKids: true`, also seeds default child-safe
 * `parental_settings` (`enabled: 1, blockAdultKeywords: 1, maxRatingAge: 12`) atomically.
 */
export async function createProfile(
  db: SqlDriver,
  input: CreateProfileInput,
  clock: () => number = Date.now,
  newId?: () => string,
): Promise<Result<ProfileRecord>> {
  const name = validateProfileName(input.name);
  if (name === null) {
    return err(elvError('source-format', 'invalid-profile-name'));
  }
  if (input.avatarToken !== undefined && !isProfileAvatarToken(input.avatarToken)) {
    return err(elvError('source-format', 'invalid-avatar-token'));
  }
  const avatarToken: ProfileAvatarToken = input.avatarToken ?? 'crimson';
  const isKids = input.isKids === true;
  const id = newId !== undefined ? newId() : defaultProfileId(clock);
  if (!isValidProfileId(id)) {
    return err(elvError('storage', 'invalid-profile-id'));
  }
  const now = Math.max(0, Math.round(clock()));

  try {
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO profiles (id, name, avatar_token, is_kids, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [id, name, avatarToken, isKids ? 1 : 0, now, now],
      );
      if (isKids) {
        await tx.run(
          `INSERT OR IGNORE INTO parental_settings (
             profile_id, enabled, block_adult_keywords, max_rating_age, unlock_timeout_min, updated_at
           ) VALUES (?, 1, 1, 12, ?, ?)`,
          [id, DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN, now],
        );
      }
    });
  } catch {
    return err(elvError('storage', 'profile-write-failed'));
  }

  if (isKids) {
    markParentalStateDirty(db);
  }

  return ok({
    id,
    name,
    avatarToken,
    isKids,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  });
}

/** Updates an existing profile's display name, avatar token, or Kids flag (`#15`). */
export async function updateProfile(
  db: SqlDriver,
  id: string,
  patch: UpdateProfilePatch,
  clock: () => number = Date.now,
): Promise<Result<ProfileRecord>> {
  if (!isValidProfileId(id)) {
    return err(elvError('storage', 'profile-not-found'));
  }
  const rows = await db.all<RawProfileRow>(
    'SELECT id, name, avatar_token, is_kids, is_default, created_at, updated_at FROM profiles WHERE id = ? LIMIT 1',
    [id],
  );
  const existing = rows[0];
  if (existing === undefined) {
    return err(elvError('storage', 'profile-not-found'));
  }

  let nextName = existing.name;
  if (patch.name !== undefined) {
    const validated = validateProfileName(patch.name);
    if (validated === null) {
      return err(elvError('source-format', 'invalid-profile-name'));
    }
    nextName = validated;
  }

  let nextAvatar = normalizeAvatarToken(existing.avatar_token);
  if (patch.avatarToken !== undefined) {
    if (!isProfileAvatarToken(patch.avatarToken)) {
      return err(elvError('source-format', 'invalid-avatar-token'));
    }
    nextAvatar = patch.avatarToken;
  }

  const wasKids = existing.is_kids !== 0;
  const nextIsKids = patch.isKids !== undefined ? patch.isKids : wasKids;
  const now = Math.max(0, Math.round(clock()));

  if (!wasKids && nextIsKids) {
    await db.transaction(async (tx) => {
      await tx.run(
        'UPDATE profiles SET name = ?, avatar_token = ?, is_kids = ?, updated_at = ? WHERE id = ?',
        [nextName, nextAvatar, 1, now, id],
      );
      await tx.run(
        `INSERT INTO parental_settings (
           profile_id, enabled, block_adult_keywords, max_rating_age, unlock_timeout_min, updated_at
         ) VALUES (?, 1, 1, 12, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           enabled = 1,
           block_adult_keywords = CASE WHEN parental_settings.enabled = 0 THEN 1 ELSE parental_settings.block_adult_keywords END,
           max_rating_age = CASE WHEN parental_settings.enabled = 0 AND parental_settings.max_rating_age IS NULL THEN 12 ELSE parental_settings.max_rating_age END,
           updated_at = CASE WHEN parental_settings.enabled = 0 THEN excluded.updated_at ELSE parental_settings.updated_at END`,
        [id, DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN, now],
      );
    });
    markParentalStateDirty(db);
  } else {
    await db.run(
      'UPDATE profiles SET name = ?, avatar_token = ?, is_kids = ?, updated_at = ? WHERE id = ?',
      [nextName, nextAvatar, nextIsKids ? 1 : 0, now, id],
    );
  }

  return ok({
    id: existing.id,
    name: nextName,
    avatarToken: nextAvatar,
    isKids: nextIsKids,
    isDefault: existing.is_default !== 0,
    createdAt: existing.created_at,
    updatedAt: now,
  });
}

/**
 * Deletes a non-last local profile and cascades deletion of all profile-scoped SQLite tables
 * (`watch_progress`, `favorites`, `track_preferences`, `recent_channels`, `parental_settings`,
 * `parental_locks`) in a single transaction, then removes `profile.<id>.pin` from `SecretStore`.
 * Refuses to delete the last remaining profile with `storage/cannot-delete-last-profile`.
 */
export async function deleteProfile(
  db: SqlDriver,
  secrets: SecretStore,
  id: string,
): Promise<Result<void>> {
  if (!isValidProfileId(id)) {
    return err(elvError('storage', 'profile-not-found'));
  }
  const outcome = await db.transaction(async (tx) => {
    const allProfiles = await tx.all<{ id: string; is_default: number }>(
      'SELECT id, is_default FROM profiles ORDER BY is_default DESC, created_at ASC, id ASC',
    );
    const target = allProfiles.find((p) => p.id === id);
    if (target === undefined) return 'not-found' as const;
    if (allProfiles.length <= 1) return 'last-profile' as const;

    await tx.run('DELETE FROM profiles WHERE id = ?', [id]);
    await tx.run('DELETE FROM watch_progress WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM favorites WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM track_preferences WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM recent_channels WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM parental_settings WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM parental_locks WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM channel_overrides WHERE profile_id = ?', [id]);
    await tx.run(
      'DELETE FROM custom_group_items WHERE group_id IN (SELECT id FROM custom_groups WHERE profile_id = ?)',
      [id],
    );
    await tx.run('DELETE FROM custom_groups WHERE profile_id = ?', [id]);
    await tx.run(
      'DELETE FROM vod_collection_items WHERE collection_id IN (SELECT id FROM vod_collections WHERE profile_id = ?)',
      [id],
    );
    await tx.run('DELETE FROM vod_collections WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM programme_reminders WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM my_list_series_baselines WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM my_list_new_episodes WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM continue_watching_dismissals WHERE profile_id = ?', [id]);
    await tx.run('DELETE FROM ratings WHERE profile_id = ?', [id]);

    if (target.is_default !== 0) {
      const nextDefault = allProfiles.find((p) => p.id !== id);
      if (nextDefault !== undefined) {
        await tx.run('UPDATE profiles SET is_default = 1 WHERE id = ?', [nextDefault.id]);
      }
    }
    return 'deleted' as const;
  });

  if (outcome === 'not-found') {
    return err(elvError('storage', 'profile-not-found'));
  }
  if (outcome === 'last-profile') {
    return err(elvError('storage', 'cannot-delete-last-profile'));
  }

  await refreshParentalFastPath(db);
  await secrets.delete(pinSecretKey(id)).catch(() => undefined);
  return ok(undefined);
}

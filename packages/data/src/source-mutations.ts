import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { mapNewSourceRow, type SourceRow } from './catalog-source-meta';
import { isValidProfileId } from './profiles-repo';
import { getSource, type SourceRecord, type SourceSettings } from './sources';

/** CatalogService methods for mutating source name and per-profile sharing. */
export interface CatalogSourceMutationMethods {
  /** Renames an existing source (trimmed, 1–80 chars). */
  renameSource(sourceId: string, name: string): Promise<Result<SourceRow>>;
  /** Updates per-profile exclusion list for a source without clobbering other settings. */
  setSourceExcludedProfiles(
    sourceId: string,
    excludedProfileIds: readonly string[],
  ): Promise<Result<SourceRow>>;
}

/** Maximum trimmed character length of a user-editable source display name. */
export const MAX_SOURCE_NAME_LENGTH = 80;

/**
 * Renames an active source (`deleting = 0`). Trims `name` and enforces `1..80` characters.
 */
export async function renameSource(
  db: SqlDriver,
  sourceId: string,
  name: string,
): Promise<Result<SourceRecord>> {
  if (typeof name !== 'string') {
    return err(elvError('source-format', 'invalid-source-name'));
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_NAME_LENGTH) {
    return err(elvError('source-format', 'invalid-source-name'));
  }
  const existing = await getSource(db, sourceId);
  if (existing === undefined) {
    return err(elvError('storage', 'source-not-found'));
  }
  await db.run('UPDATE sources SET name = ? WHERE id = ? AND deleting = 0', [trimmed, sourceId]);
  return ok({ ...existing, name: trimmed });
}

/**
 * Updates per-profile exclusion IDs inside `sources.settings_json` without clobbering existing
 * source settings. Validates every profile ID, deduplicates, and sorts.
 */
export async function setSourceExcludedProfiles(
  db: SqlDriver,
  sourceId: string,
  excludedProfileIds: readonly string[],
): Promise<Result<SourceRecord>> {
  if (!Array.isArray(excludedProfileIds)) {
    return err(elvError('source-format', 'invalid-profile-id'));
  }
  const unique = new Set<string>();
  for (const profileId of excludedProfileIds) {
    if (!isValidProfileId(profileId)) {
      return err(elvError('source-format', 'invalid-profile-id'));
    }
    unique.add(profileId);
  }
  const existing = await getSource(db, sourceId);
  if (existing === undefined) {
    return err(elvError('storage', 'source-not-found'));
  }
  const normalized = [...unique].sort();
  const nextSettings: SourceSettings = { ...existing.settings };
  if (normalized.length === 0) {
    delete nextSettings.excludedProfileIds;
  } else {
    nextSettings.excludedProfileIds = normalized;
  }
  await db.run('UPDATE sources SET settings_json = ? WHERE id = ? AND deleting = 0', [
    JSON.stringify(nextSettings),
    sourceId,
  ]);
  return ok({ ...existing, settings: nextSettings });
}

/** @internal Builds `renameSource` and `setSourceExcludedProfiles` methods for `CatalogService`. */
export function createCatalogSourceMutationMethods(deps: {
  db: SqlDriver;
  evictPlaytime: (sourceId: string) => void;
  syncManifest: () => Promise<void> | undefined;
  listSources: () => Promise<SourceRow[]>;
}): CatalogSourceMutationMethods {
  const resolveRow = async (record: SourceRecord): Promise<SourceRow> => {
    const listed = await deps.listSources();
    return listed.find((s) => s.id === record.id) ?? mapNewSourceRow(record);
  };
  return {
    async renameSource(sourceId, name) {
      const updated = await renameSource(deps.db, sourceId, name);
      if (!updated.ok) return updated;
      deps.evictPlaytime(sourceId);
      await deps.syncManifest();
      return ok(await resolveRow(updated.value));
    },
    async setSourceExcludedProfiles(sourceId, excludedProfileIds) {
      const updated = await setSourceExcludedProfiles(deps.db, sourceId, excludedProfileIds);
      if (!updated.ok) return updated;
      deps.evictPlaytime(sourceId);
      await deps.syncManifest();
      return ok(await resolveRow(updated.value));
    },
  };
}

import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { recoverRuns } from './runs';
import { MIGRATIONS, OPEN_PRAGMAS } from './schema';

/** Schema version this build writes and understands (`PRAGMA user_version`). */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applies the open pragmas and brings the database to {@link SCHEMA_VERSION} in one transaction.
 * Returns `storage/schema-too-new` for a database written by a newer build and `storage/migration-failed`
 * (rolled back, `user_version` unchanged) when a migration throws. Runs left `running` by a crashed process are
 * marked `failed` / `interrupted` (no import can be running while the catalog is being opened).
 */
export async function openCatalog(
  db: SqlDriver,
  clock: () => number = Date.now,
): Promise<Result<void>> {
  try {
    const rows = await db.all<{ user_version: number }>('PRAGMA user_version');
    const current = rows[0]?.user_version ?? 0;
    if (current > SCHEMA_VERSION) {
      return err(elvError('storage', 'schema-too-new', `database version ${current}`));
    }
    for (const pragma of OPEN_PRAGMAS) await db.exec(pragma);
    if (current === SCHEMA_VERSION) {
      await recoverRuns(db, clock());
      return ok(undefined);
    }
    await db.transaction(async (tx) => {
      for (let v = current; v < SCHEMA_VERSION; v++) {
        await tx.exec(MIGRATIONS[v] ?? '');
        await tx.exec(`PRAGMA user_version = ${v + 1}`);
      }
    });
    return ok(undefined);
  } catch (error) {
    return err(
      elvError('storage', 'migration-failed', error instanceof Error ? error.message : 'unknown'),
    );
  }
}

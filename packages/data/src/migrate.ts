import { elvError, err, ok, type Result, type SqlDriver } from '@elv/domain';
import { recoverRuns } from './runs';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS, OPEN_PRAGMAS } from './schema';

/** Schema version this build writes and understands (`PRAGMA user_version`). */
export const SCHEMA_VERSION = MIGRATIONS.length;

async function verifyAndHealSchema(db: SqlDriver): Promise<Result<void>> {
  const repairs: string[] = [];
  for (const [table, expected] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.length === 0) {
      return err(elvError('storage', 'schema-corrupt', `missing table ${table}`));
    }
    const existing = new Set(cols.map((c) => c.name));
    for (const column of expected) {
      if (!existing.has(column.name)) {
        repairs.push(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.alterDefinition}`);
      }
    }
  }
  if (repairs.length > 0) {
    await db.transaction(async (tx) => {
      for (const sql of repairs) await tx.exec(sql);
    });
  }
  return ok(undefined);
}

/**
 * Applies the open pragmas and brings the database to {@link SCHEMA_VERSION} in one transaction, then verifies
 * expected table columns via `PRAGMA table_info` and self-heals any missing columns in a single transaction.
 * Returns `storage/schema-too-new` for a database written by a newer build, `storage/schema-corrupt` if a required
 * table is missing at `SCHEMA_VERSION`, and `storage/migration-failed` (rolled back, `user_version` unchanged) when
 * a migration throws. Runs left `running` by a crashed process are marked `failed` / `interrupted` (no import can
 * be running while the catalog is being opened).
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
    if (current < SCHEMA_VERSION) {
      await db.transaction(async (tx) => {
        for (let v = current; v < SCHEMA_VERSION; v++) {
          await tx.exec(MIGRATIONS[v] ?? '');
          await tx.exec(`PRAGMA user_version = ${v + 1}`);
        }
      });
    }
    const verified = await verifyAndHealSchema(db);
    if (!verified.ok) return verified;
    await recoverRuns(db, clock());
    return ok(undefined);
  } catch (error) {
    return err(
      elvError('storage', 'migration-failed', error instanceof Error ? error.message : 'unknown'),
    );
  }
}

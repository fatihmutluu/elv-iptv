import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createFetchHttpClient, type FetchLike, type SqlDriver } from '@elv/domain';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { startSim } from '../../../../tools/src/sim/server.ts';
import { type CatalogDeps, type CatalogService, createCatalogService } from './catalog';

/** The domain fetch client over Node's fetch. Test helper. */
export const http = createFetchHttpClient(fetch as unknown as FetchLike);

/** Starts the in-process simulator for the tests of one file; `url()` is its base URL. Test helper. */
export function useSim(): { url(): string } {
  let sim: Awaited<ReturnType<typeof startSim>> | undefined;
  beforeAll(async () => {
    sim = await startSim({ port: 0, clock: new Date('2026-06-15T12:00:00Z'), ffmpegPath: null });
  });
  afterAll(async () => {
    await sim?.close();
  });
  return {
    url() {
      if (sim === undefined) throw new Error('the simulator is not running');
      return sim.url;
    },
  };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A service over a fresh migrated test database. */
export interface Env {
  service: CatalogService;
  db: SqlDriver;
  raw: ReturnType<typeof testDb>['raw'];
  secrets: ReturnType<typeof memorySecrets>;
  setAbortSignal: ReturnType<typeof vi.fn>;
}

/** Opens a migrated in-memory catalog with a recording `setAbortSignal` and wires a service over it. Test helper. */
export async function env(
  overrides: Partial<CatalogDeps> = {},
  wrap: (db: SqlDriver) => SqlDriver = (db) => db,
): Promise<Env> {
  const t = testDb();
  closers.push(t.close);
  const setAbortSignal = vi.fn();
  const db = wrap(Object.assign(t.db, { setAbortSignal }) as SqlDriver);
  const { openCatalog } = await import('@elv/data');
  await openCatalog(db);
  const secrets = memorySecrets();
  let n = 0;
  const service = createCatalogService({
    db,
    secrets,
    scheduler: countingScheduler(),
    http,
    clock: () => 1_000,
    newId: () => `src${++n}`,
    ...overrides,
  });
  return { service, db, raw: t.raw, secrets, setAbortSignal };
}

/** The value of an ok result; throws on a failure. Test helper. */
export const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`unexpected failure: ${JSON.stringify(r.error)}`);
  return r.value;
};

/** Adds the simulator account `account` (password = username) as an Xtream source and returns its id. Test helper. */
export async function addAccount(
  e: Env,
  server: string,
  account = 'demo',
  name = 'Main',
): Promise<string> {
  const added = await e.service.addSource({
    kind: 'xtream',
    name,
    server,
    username: account,
    password: account,
  });
  return must(added).id;
}

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addM3uSource,
  addXtreamSource,
  createSyncSqlDriver,
  type ImportDeps,
  openCatalog,
} from '@elv/data';
import {
  type HttpClient,
  type HttpResponse,
  ok,
  type Result,
  type Scheduler,
  type SecretStore,
  type SqlDriver,
} from '@elv/domain';
import Database from 'better-sqlite3';
import { gunzipAdapter, http, type Sim } from './sources-sim-helpers.ts';

/** In-memory secret store that can dump its content. */
function memorySecrets(): SecretStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

/** Scheduler that counts how often it was asked to yield. */
function countingScheduler(): Scheduler & { readonly count: number } {
  let count = 0;
  return {
    get count() {
      return count;
    },
    yieldNow: async () => {
      count += 1;
    },
  };
}

export interface Env {
  raw: Database.Database;
  db: SqlDriver;
  secrets: ReturnType<typeof memorySecrets>;
  deps: ImportDeps;
  file: string | undefined;
  /** Values that must never reach a database column. */
  forbidden: string[];
  close(): void;
}

/** A migrated catalog database (in memory, or a temp file) with in-memory secrets and the real HTTP client. */
export async function openEnv(options: { file?: boolean; client?: HttpClient } = {}): Promise<Env> {
  const dir = options.file ? mkdtempSync(join(tmpdir(), 'elv-import-')) : undefined;
  const file = dir === undefined ? undefined : join(dir, 'catalog.db');
  const raw = new Database(file ?? ':memory:');
  const db = createSyncSqlDriver(raw);
  await openCatalog(db);
  const secrets = memorySecrets();
  return {
    raw,
    db,
    secrets,
    file,
    forbidden: [],
    deps: {
      db,
      http: options.client ?? http,
      secrets,
      scheduler: countingScheduler(),
      clock: () => Date.now(),
      decompressor: gunzipAdapter,
    },
    close: () => {
      raw.close();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Bytes of the database file including its write-ahead log. */
function fileBytes(env: Env): number {
  if (env.file === undefined) return 0;
  const size = (path: string): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  return size(env.file) + size(`${env.file}-wal`);
}

const ids = { next: 0 };
const newId = (): string => `s${++ids.next}`;
const addDeps = (env: Env) => ({
  db: env.db,
  secrets: env.secrets,
  clock: () => 1,
  newId,
});

/** Credentials of a simulator account (password = username) as the strings that must stay out of the database. */
function credentialNeedles(sim: Sim, user: string): string[] {
  return [
    `username=${user}`,
    `password=${user}`,
    `/${user}/${user}/`,
    sim.url.replace('http://', `http://${user}:${user}@`),
  ];
}

export async function xtreamSource(
  env: Env,
  sim: Sim,
  user: string,
  password = user,
): Promise<string> {
  const added = await addXtreamSource(
    { name: `Panel ${user}`, server: sim.url, username: user, password },
    addDeps(env),
  );
  if (!added.ok) throw new Error('addXtreamSource failed');
  env.forbidden.push(...credentialNeedles(sim, user));
  return added.value.id;
}

export function playlistLink(sim: Sim, user: string): string {
  return `${sim.url}/get.php?username=${user}&password=${user}&type=m3u_plus&output=ts`;
}

export async function m3uSource(env: Env, sim: Sim, user: string): Promise<string> {
  const url = playlistLink(sim, user);
  const added = await addM3uSource({ name: `List ${user}`, playlistUrl: url }, addDeps(env));
  if (!added.ok) throw new Error('addM3uSource failed');
  env.forbidden.push(url, ...credentialNeedles(sim, user));
  return added.value.id;
}

export const count = async (db: SqlDriver, sql: string, params: unknown[] = []): Promise<number> =>
  (await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, params as never))[0]?.n ?? 0;

export interface SecretHit {
  table: string;
  column: string;
  needle: string;
}

/** Looks for every needle in every column of every table (text and blob alike, through `CAST`). */
export function scanForSecrets(raw: Database.Database, needles: readonly string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name: table } of tables) {
    const columns = raw.prepare('SELECT name FROM pragma_table_info(?)').all(table) as {
      name: string;
    }[];
    for (const { name: column } of columns) {
      for (const needle of needles) {
        const sql = `SELECT 1 FROM "${table}" WHERE instr(CAST("${column}" AS TEXT), ?) > 0 LIMIT 1`;
        if (raw.prepare(sql).get(needle) !== undefined) hits.push({ table, column, needle });
      }
    }
  }
  return hits;
}

/** Wraps a client and lets `rewrite` replace the parsed JSON body of an Xtream action. */
export function rewritingClient(
  inner: HttpClient,
  action: string,
  rewrite: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
): HttpClient {
  return {
    async get(url, options): Promise<Result<HttpResponse>> {
      const res = await inner.get(url, options);
      if (!res.ok || new URL(url).searchParams.get('action') !== action) return res;
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.value.body) chunks.push(chunk);
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      const bytes = new TextEncoder().encode(JSON.stringify(rewrite(JSON.parse(text))));
      return ok({
        status: res.value.status,
        headers: res.value.headers,
        body: (async function* () {
          yield bytes;
        })(),
      });
    },
  };
}

/** Sends requests aimed at `from` to `to` instead, so one stored source can talk to another simulator. */
export function redirectingClient(inner: HttpClient, from: string, to: string): HttpClient {
  return { get: (url, options) => inner.get(url.replace(from, to), options) };
}

/** Peak live heap above the starting level, sampled after a forced collection every `every` calls. */
function heapSampler(every = 100): { tick(): void; growthMb(): number } {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('gc is not exposed: run Vitest with execArgv --expose-gc');
  const collect = (): number => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  const base = collect();
  let peak = base;
  let calls = 0;
  return {
    tick() {
      if (++calls % every === 0) peak = Math.max(peak, collect());
    },
    growthMb: () => Math.max(0, Math.max(peak, collect()) - base) / 1_048_576,
  };
}

export interface ImportReport {
  rows: number;
  seconds: number;
  perSecond: number;
  heapGrowthMb: number;
  dbMb: number;
  line: string;
}

/** Runs one import against a file database and reports rows, time, rate, heap growth and file size. */
export async function measureImport(
  label: string,
  env: Env,
  run: (onProgress: () => void) => Promise<Record<string, number>>,
  rowKeys: readonly string[],
): Promise<ImportReport> {
  const heap = heapSampler();
  const started = performance.now();
  const counts = await run(() => heap.tick());
  const seconds = (performance.now() - started) / 1000;
  const rows = rowKeys.reduce((n, key) => n + (counts[key] ?? 0), 0);
  const perSecond = rows / seconds;
  const heapGrowthMb = heap.growthMb();
  const dbMb = fileBytes(env) / 1_048_576;
  const line = `${label}: ${rows} rows, ${seconds.toFixed(2)} s, ${Math.round(perSecond)} rows/s, db ${dbMb.toFixed(1)} MB, heap +${heapGrowthMb.toFixed(1)} MB`;
  return { rows, seconds, perSecond, heapGrowthMb, dbMb, line };
}

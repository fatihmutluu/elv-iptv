import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';

/** Official IMDb non-commercial ratings TSV dataset URL. */
const DEFAULT_IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
/** Default minimum vote count keeping synced row volume well inside D1 Free Tier writes. */
const DEFAULT_MIN_VOTES = 500;
/** Default rows per generated `.sql` chunk file. */
const DEFAULT_SQL_CHUNK_SIZE = 5_000;
/** Default rows per `INSERT` statement inside a chunk file (safe D1 SQL length). */
const DEFAULT_ROWS_PER_STATEMENT = 500;

const IMDB_ID_RE = /^tt\d{5,10}$/;
const D1_DB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLOUDFLARE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const SYNC_IMDB_RATINGS_USAGE = [
  'usage: sync-imdb-ratings [--min-votes <N>] [--limit <N>] [--out-dir <dir>] [--apply-d1 <db-name>] [--apply-d1-api] [--config <wrangler.toml>] [--input <path>]',
].join('\n');

/** Parsed IMDb dataset rating entry ready for SQL batching. */
export interface ImdbRatingEntry {
  readonly imdbId: string;
  readonly rating: number;
  readonly votes: number;
}

/** Generated SQL file chunk produced from parsed IMDb ratings. */
export interface ImdbRatingsSqlChunk {
  readonly filename: string;
  readonly sql: string;
  readonly rowCount: number;
}

/** Parsed CLI flags for `sync-imdb-ratings`. */
export interface SyncImdbRatingsOptions {
  readonly help: boolean;
  readonly minVotes: number;
  readonly limit: number | null;
  readonly outDir: string | null;
  readonly applyD1: string | null;
  readonly applyD1Api: boolean;
  readonly wranglerConfig: string | null;
  readonly inputPath: string | null;
}

/** Injectable I/O seams for testing `runSyncImdbRatingsCli`. */
export interface SyncImdbRatingsIo {
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly execFileSyncImpl?: (
    file: string,
    args: readonly string[],
    options: ExecFileSyncOptions,
  ) => unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
  readonly chunkSize?: number;
  readonly rowsPerStatement?: number;
  readonly wranglerBin?: string;
}

function parsePositiveIntFlag(raw: string, flagName: string, allowZero = false): number {
  const num = Number(raw);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(num) || num < min) {
    throw new Error(`${flagName} must be an integer >= ${min}`);
  }
  return num;
}

/** Parses and validates `sync-imdb-ratings` CLI arguments. */
export function parseImdbRatingsSyncArgs(argv: readonly string[]): SyncImdbRatingsOptions {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'min-votes': { type: 'string' },
      limit: { type: 'string' },
      'out-dir': { type: 'string' },
      'apply-d1': { type: 'string' },
      'apply-d1-api': { type: 'boolean', default: false },
      config: { type: 'string' },
      input: { type: 'string' },
    },
  });

  if (values.help) {
    return {
      help: true,
      minVotes: DEFAULT_MIN_VOTES,
      limit: null,
      outDir: null,
      applyD1: null,
      applyD1Api: false,
      wranglerConfig: null,
      inputPath: null,
    };
  }

  const minVotes =
    values['min-votes'] !== undefined
      ? parsePositiveIntFlag(values['min-votes'], '--min-votes', true)
      : DEFAULT_MIN_VOTES;
  const limit =
    values.limit !== undefined ? parsePositiveIntFlag(values.limit, '--limit', false) : null;
  const outDir = values['out-dir']?.trim() ? values['out-dir'].trim() : null;
  const applyD1 = values['apply-d1']?.trim() ? values['apply-d1'].trim() : null;
  const applyD1Api = Boolean(values['apply-d1-api']);
  const wranglerConfig = values.config?.trim() ? values.config.trim() : null;
  const inputPath = values.input?.trim() ? values.input.trim() : null;

  if (applyD1 !== null && !D1_DB_NAME_RE.test(applyD1)) {
    throw new Error('--apply-d1 must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
  }
  if (!outDir && !applyD1 && !applyD1Api) {
    throw new Error('Specify at least --out-dir <dir>, --apply-d1 <db-name>, or --apply-d1-api');
  }

  return { help: false, minVotes, limit, outDir, applyD1, applyD1Api, wranglerConfig, inputPath };
}

/** Parses one `tconst\taverageRating\tnumVotes` TSV line, returning `null` if invalid or below `minVotes`. */
function parseImdbRatingsLine(line: string, minVotes: number): ImdbRatingEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('tconst\t')) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 3) return null;
  const imdbId = parts[0]?.trim() ?? '';
  if (!IMDB_ID_RE.test(imdbId)) return null;

  const ratingRaw = Number(parts[1]);
  if (!Number.isFinite(ratingRaw) || ratingRaw < 0 || ratingRaw > 10) return null;

  const votesRaw = Number(parts[2]);
  if (!Number.isInteger(votesRaw) || votesRaw < minVotes) return null;

  return {
    imdbId,
    rating: Math.round(ratingRaw * 10) / 10,
    votes: votesRaw,
  };
}

function finalizeParsedEntries(
  entries: ImdbRatingEntry[],
  limit: number | null,
): ImdbRatingEntry[] {
  entries.sort((a, b) => b.votes - a.votes || a.imdbId.localeCompare(b.imdbId));
  return limit !== null ? entries.slice(0, limit) : entries;
}

/** Parses an in-memory `title.ratings.tsv` string, sorted by `votes DESC`. */
export function parseImdbRatingsTsv(
  tsvText: string,
  options: { readonly minVotes?: number; readonly limit?: number | null } = {},
): ImdbRatingEntry[] {
  const minVotes = options.minVotes ?? DEFAULT_MIN_VOTES;
  const entries: ImdbRatingEntry[] = [];
  for (const line of tsvText.split(/\r?\n/)) {
    const parsed = parseImdbRatingsLine(line, minVotes);
    if (parsed) entries.push(parsed);
  }
  return finalizeParsedEntries(entries, options.limit ?? null);
}

/** Streams a Node `Readable` TSV line-by-line to keep peak memory low on the full IMDb dataset. */
async function parseImdbRatingsStream(
  input: NodeJS.ReadableStream,
  options: { readonly minVotes?: number; readonly limit?: number | null } = {},
): Promise<ImdbRatingEntry[]> {
  const minVotes = options.minVotes ?? DEFAULT_MIN_VOTES;
  const entries: ImdbRatingEntry[] = [];
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    const parsed = parseImdbRatingsLine(line, minVotes);
    if (parsed) entries.push(parsed);
  }
  return finalizeParsedEntries(entries, options.limit ?? null);
}

/** Formats delta-safe multi-row SQL upserts into `elv_imdb_ratings`. */
export function formatImdbRatingsUpsertSql(
  rows: readonly ImdbRatingEntry[],
  updatedAtMs: number,
  options: { readonly rowsPerStatement?: number } = {},
): string {
  if (rows.length === 0) return '';
  if (!Number.isInteger(updatedAtMs) || updatedAtMs < 0) {
    throw new Error('updatedAtMs must be a non-negative integer');
  }
  const batchSize = Math.max(1, options.rowsPerStatement ?? DEFAULT_ROWS_PER_STATEMENT);
  const statements: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const values = slice
      .map((row) => {
        if (!IMDB_ID_RE.test(row.imdbId)) {
          throw new Error(`Invalid IMDb ID in SQL generator: ${row.imdbId}`);
        }
        if (!Number.isFinite(row.rating) || row.rating < 0 || row.rating > 10) {
          throw new Error(`Invalid rating in SQL generator for ${row.imdbId}`);
        }
        if (!Number.isInteger(row.votes) || row.votes < 0) {
          throw new Error(`Invalid votes in SQL generator for ${row.imdbId}`);
        }
        const safeRating = Math.round(row.rating * 10) / 10;
        const safeVotes = row.votes;
        return `('${row.imdbId}', ${safeRating.toFixed(1)}, ${safeVotes}, ${updatedAtMs})`;
      })
      .join(',\n  ');
    statements.push(
      `INSERT INTO elv_imdb_ratings (imdb_id, rating, votes, updated_at)\nVALUES\n  ${values}\nON CONFLICT(imdb_id) DO UPDATE SET\n  rating = excluded.rating,\n  votes = excluded.votes,\n  updated_at = excluded.updated_at\nWHERE elv_imdb_ratings.rating != excluded.rating OR elv_imdb_ratings.votes != excluded.votes;`,
    );
  }

  return `${statements.join('\n\n')}\n`;
}

/** Splits rating entries into numbered `.sql` chunks safe for D1 remote execution. */
export function chunkImdbRatingsSql(
  rows: readonly ImdbRatingEntry[],
  options: {
    readonly chunkSize?: number;
    readonly rowsPerStatement?: number;
    readonly updatedAtMs?: number;
  } = {},
): ImdbRatingsSqlChunk[] {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_SQL_CHUNK_SIZE);
  const rowsPerStatement = Math.max(1, options.rowsPerStatement ?? DEFAULT_ROWS_PER_STATEMENT);
  const updatedAtMs = options.updatedAtMs ?? Date.now();
  const chunks: ImdbRatingsSqlChunk[] = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const index = chunks.length + 1;
    const filename = `chunk-${String(index).padStart(4, '0')}.sql`;
    chunks.push({
      filename,
      sql: formatImdbRatingsUpsertSql(slice, updatedAtMs, { rowsPerStatement }),
      rowCount: slice.length,
    });
  }
  return chunks;
}

async function openRatingsInputStream(
  options: SyncImdbRatingsOptions,
  fetchImpl: typeof fetch,
): Promise<NodeJS.ReadableStream> {
  if (options.inputPath) {
    const rawStream = createReadStream(options.inputPath);
    return options.inputPath.toLowerCase().endsWith('.gz')
      ? rawStream.pipe(createGunzip())
      : rawStream;
  }

  const res = await fetchImpl(DEFAULT_IMDB_RATINGS_URL, {
    method: 'GET',
    headers: { Accept: 'application/gzip, application/octet-stream' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch ${DEFAULT_IMDB_RATINGS_URL}: HTTP ${res.status}`);
  }
  const nodeStream = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  return nodeStream.pipe(createGunzip());
}

async function applySqlChunksViaD1Api(
  chunks: readonly ImdbRatingsSqlChunk[],
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const apiToken = (env.CLOUDFLARE_API_TOKEN ?? '').trim();
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const databaseId = (env.ELV_D1_DATABASE_ID ?? env.D1_DATABASE_ID ?? '').trim();
  if (!apiToken) throw new Error('--apply-d1-api requires CLOUDFLARE_API_TOKEN');
  if (!CLOUDFLARE_ID_RE.test(accountId)) {
    throw new Error('--apply-d1-api requires a valid CLOUDFLARE_ACCOUNT_ID');
  }
  if (!CLOUDFLARE_ID_RE.test(databaseId)) {
    throw new Error('--apply-d1-api requires a valid ELV_D1_DATABASE_ID (or D1_DATABASE_ID)');
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  for (const chunk of chunks) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql: chunk.sql }),
    });
    if (!res.ok) {
      throw new Error(`Cloudflare D1 API failed on ${chunk.filename}: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { readonly success?: boolean };
    if (body.success === false) {
      throw new Error(`Cloudflare D1 API rejected ${chunk.filename}`);
    }
  }
}

/** Executes the `sync-imdb-ratings` CLI end-to-end and returns process exit code. */
export async function runSyncImdbRatingsCli(
  argv: readonly string[],
  io: SyncImdbRatingsIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const fetchImpl = io.fetchImpl ?? fetch;
  const execFile = io.execFileSyncImpl ?? execFileSync;
  const env = io.env ?? process.env;
  const nowMs = io.nowMs ?? (() => Date.now());
  const wranglerBin = io.wranglerBin ?? 'wrangler';

  let options: SyncImdbRatingsOptions;
  try {
    options = parseImdbRatingsSyncArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${message}\n${SYNC_IMDB_RATINGS_USAGE}\n`);
    return 2;
  }

  if (options.help) {
    stdout(`${SYNC_IMDB_RATINGS_USAGE}\n`);
    return 0;
  }

  let tempOutDir: string | null = null;
  try {
    const stream = await openRatingsInputStream(options, fetchImpl);
    const entries = await parseImdbRatingsStream(stream, {
      minVotes: options.minVotes,
      limit: options.limit,
    });
    const chunks = chunkImdbRatingsSql(entries, {
      chunkSize: io.chunkSize ?? DEFAULT_SQL_CHUNK_SIZE,
      rowsPerStatement: io.rowsPerStatement ?? DEFAULT_ROWS_PER_STATEMENT,
      updatedAtMs: Math.floor(nowMs()),
    });

    const targetDir =
      options.outDir ??
      (() => {
        tempOutDir = mkdtempSync(join(tmpdir(), 'elv-imdb-ratings-sql-'));
        return tempOutDir;
      })();
    mkdirSync(targetDir, { recursive: true });

    const writtenPaths: string[] = [];
    for (const chunk of chunks) {
      const filePath = join(targetDir, chunk.filename);
      writeFileSync(filePath, chunk.sql, 'utf8');
      writtenPaths.push(filePath);
    }

    stdout(
      `sync-imdb-ratings: parsed ${entries.length} titles (minVotes=${options.minVotes}), wrote ${writtenPaths.length} SQL chunk(s) to ${targetDir}\n`,
    );

    if (options.applyD1) {
      for (const filePath of writtenPaths) {
        const wranglerArgs = [
          'd1',
          'execute',
          options.applyD1,
          '--remote',
          ...(options.wranglerConfig ? ['--config', options.wranglerConfig] : []),
          '--file',
          filePath,
        ];
        execFile(wranglerBin, wranglerArgs, {
          stdio: 'inherit',
        });
      }
      stdout(
        `sync-imdb-ratings: applied ${writtenPaths.length} chunk(s) to D1 database "${options.applyD1}"\n`,
      );
    }
    if (options.applyD1Api) {
      await applySqlChunksViaD1Api(chunks, env, fetchImpl);
      stdout(`sync-imdb-ratings: applied ${chunks.length} chunk(s) via Cloudflare D1 REST API\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`sync-imdb-ratings failed: ${message}\n`);
    return 1;
  } finally {
    if (tempOutDir) {
      rmSync(tempOutDir, { recursive: true, force: true });
    }
  }
}

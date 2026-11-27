import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkImdbRatingsSql,
  formatImdbRatingsUpsertSql,
  parseImdbRatingsSyncArgs,
  parseImdbRatingsTsv,
  runSyncImdbRatingsCli,
} from '../src/imdb-ratings-sync.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-imdb-ratings-sync-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE_TSV = [
  'tconst\taverageRating\tnumVotes',
  'tt0111161\t9.3\t2950000',
  'tt0068646\t9.2\t2050000',
  'tt1375666\t8.8\t2550000',
  'tt0000001\t5.7\t200',
  'nm0000138\t9.9\t999999',
  'tt1234\t8.0\t900',
  'tt9999999\t12.5\t1000',
  'tt8888888\t\\N\t1000',
  'tt7777777\t7.1\t500',
  '',
].join('\n');

describe('IMDb official ratings TSV parser & SQL chunk generator', () => {
  it('parses valid IMDb rows >= minVotes, filters invalid IDs/ratings, sorts by votes DESC, and respects limit', () => {
    const rows = parseImdbRatingsTsv(SAMPLE_TSV, { minVotes: 500 });
    expect(rows).toEqual([
      { imdbId: 'tt0111161', rating: 9.3, votes: 2_950_000 },
      { imdbId: 'tt1375666', rating: 8.8, votes: 2_550_000 },
      { imdbId: 'tt0068646', rating: 9.2, votes: 2_050_000 },
      { imdbId: 'tt7777777', rating: 7.1, votes: 500 },
    ]);

    const limited = parseImdbRatingsTsv(SAMPLE_TSV, { minVotes: 500, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.imdbId)).toEqual(['tt0111161', 'tt1375666']);
  });

  it('generates delta-safe multi-row SQL that executes cleanly in SQLite without rewriting unchanged rows', () => {
    const rows = parseImdbRatingsTsv(SAMPLE_TSV, { minVotes: 500 });
    const chunks = chunkImdbRatingsSql(rows, {
      chunkSize: 2,
      rowsPerStatement: 2,
      updatedAtMs: 1_764_212_100_000,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.filename).toBe('chunk-0001.sql');
    expect(chunks[1]?.filename).toBe('chunk-0002.sql');
    expect(chunks[0]?.sql).toContain('ON CONFLICT(imdb_id) DO UPDATE SET');
    expect(chunks[0]?.sql).toContain(
      'WHERE elv_imdb_ratings.rating != excluded.rating OR elv_imdb_ratings.votes != excluded.votes',
    );

    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE elv_imdb_ratings (
        imdb_id TEXT PRIMARY KEY,
        rating REAL NOT NULL,
        votes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    for (const chunk of chunks) {
      sqlite.exec(chunk.sql);
    }

    const stored = sqlite
      .prepare(
        'SELECT imdb_id, rating, votes, updated_at FROM elv_imdb_ratings ORDER BY votes DESC',
      )
      .all() as Array<{ imdb_id: string; rating: number; votes: number; updated_at: number }>;
    expect(stored).toHaveLength(4);
    expect(stored[0]).toEqual({
      imdb_id: 'tt0111161',
      rating: 9.3,
      votes: 2_950_000,
      updated_at: 1_764_212_100_000,
    });

    // Re-run identical values at a later timestamp -> WHERE guard prevents unnecessary row churn
    const laterSql = formatImdbRatingsUpsertSql(rows, 1_764_999_999_000);
    sqlite.exec(laterSql);
    const afterUnchanged = sqlite
      .prepare("SELECT updated_at FROM elv_imdb_ratings WHERE imdb_id = 'tt0111161'")
      .get() as { updated_at: number };
    expect(afterUnchanged.updated_at).toBe(1_764_212_100_000);

    // Update votes -> WHERE guard triggers clean update
    const updatedSql = formatImdbRatingsUpsertSql(
      [{ imdbId: 'tt0111161', rating: 9.3, votes: 2_960_000 }],
      1_764_999_999_000,
    );
    sqlite.exec(updatedSql);
    const afterChanged = sqlite
      .prepare("SELECT votes, updated_at FROM elv_imdb_ratings WHERE imdb_id = 'tt0111161'")
      .get() as { votes: number; updated_at: number };
    expect(afterChanged).toEqual({ votes: 2_960_000, updated_at: 1_764_999_999_000 });
    sqlite.close();
  });

  it('parses CLI flags cleanly and streams gzipped TSV files to chunked SQL files and wrangler D1 apply', async () => {
    const dir = makeTempDir();
    const gzPath = join(dir, 'title.ratings.tsv.gz');
    const outDir = join(dir, 'sql-out');
    writeFileSync(gzPath, gzipSync(Buffer.from(SAMPLE_TSV, 'utf8')));

    const parsed = parseImdbRatingsSyncArgs([
      '--min-votes',
      '500',
      '--limit',
      '3',
      '--out-dir',
      outDir,
      '--apply-d1',
      'elv-sync-db',
      '--input',
      gzPath,
    ]);
    expect(parsed.minVotes).toBe(500);
    expect(parsed.limit).toBe(3);
    expect(parsed.outDir).toBe(outDir);
    expect(parsed.applyD1).toBe('elv-sync-db');

    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const logs: string[] = [];
    const exitCode = await runSyncImdbRatingsCli(
      [
        '--min-votes',
        '500',
        '--limit',
        '3',
        '--out-dir',
        outDir,
        '--apply-d1',
        'elv-sync-db',
        '--input',
        gzPath,
      ],
      {
        chunkSize: 2,
        nowMs: () => 1_764_212_100_000,
        stdout: (msg) => logs.push(msg),
        stderr: (msg) => logs.push(msg),
        execFileSyncImpl: (file, args) => {
          execCalls.push({ file, args });
          return Buffer.from('');
        },
      },
    );

    expect(exitCode).toBe(0);
    const files = readdirSync(outDir).sort();
    expect(files).toEqual(['chunk-0001.sql', 'chunk-0002.sql']);
    expect(readFileSync(join(outDir, 'chunk-0001.sql'), 'utf8')).toContain('tt0111161');
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]?.args).toEqual([
      'd1',
      'execute',
      'elv-sync-db',
      '--remote',
      '--file',
      join(outDir, 'chunk-0001.sql'),
    ]);
    expect(execCalls[1]?.args).toEqual([
      'd1',
      'execute',
      'elv-sync-db',
      '--remote',
      '--file',
      join(outDir, 'chunk-0002.sql'),
    ]);
  });

  it('streams gzipped download via fetchImpl when --input is omitted and rejects unsafe --apply-d1 names', async () => {
    const dir = makeTempDir();
    const outDir = join(dir, 'remote-out');
    const gzBuffer = gzipSync(Buffer.from(SAMPLE_TSV, 'utf8'));
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://datasets.imdbws.com/title.ratings.tsv.gz');
      return new Response(new Uint8Array(gzBuffer), { status: 200 });
    });

    const exitCode = await runSyncImdbRatingsCli(['--min-votes', '2000000', '--out-dir', outDir], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowMs: () => 1_764_212_100_000,
      stdout: () => {},
      stderr: () => {},
    });
    expect(exitCode).toBe(0);
    const sql = readFileSync(join(outDir, 'chunk-0001.sql'), 'utf8');
    expect(sql).toContain('tt0111161');
    expect(sql).not.toContain('tt7777777');

    const badExit = await runSyncImdbRatingsCli(
      ['--apply-d1', 'bad db;rm -rf', '--out-dir', outDir],
      { stdout: () => {}, stderr: () => {} },
    );
    expect(badExit).toBe(2);

    const cfgCalls: Array<readonly string[]> = [];
    const cfgExit = await runSyncImdbRatingsCli(
      [
        '--min-votes',
        '2000000',
        '--out-dir',
        join(dir, 'cfg-out'),
        '--apply-d1',
        'elv-sync-db',
        '--config',
        'apps/sync-server/wrangler.toml',
      ],
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        nowMs: () => 1_764_212_100_000,
        stdout: () => {},
        stderr: () => {},
        execFileSyncImpl: (_file, args) => {
          cfgCalls.push(args);
          return Buffer.from('');
        },
      },
    );
    expect(cfgExit).toBe(0);
    expect(cfgCalls[0]).toContain('--config');
    expect(cfgCalls[0]).toContain('apps/sync-server/wrangler.toml');

    expect(() =>
      formatImdbRatingsUpsertSql(
        [{ imdbId: 'tt0111161', rating: Number.NaN, votes: 1000 }],
        1_764_212_100_000,
      ),
    ).toThrow(/Invalid rating/);
    expect(() =>
      formatImdbRatingsUpsertSql(
        [{ imdbId: 'tt0111161', rating: 8.5, votes: -5 }],
        1_764_212_100_000,
      ),
    ).toThrow(/Invalid votes/);
  });
});

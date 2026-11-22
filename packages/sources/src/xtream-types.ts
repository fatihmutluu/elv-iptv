import type { ContentKind, HttpClient, Result, TransportSettings } from '@elv/domain';

/** Account state from `user_info` and `server_info`; times are epoch milliseconds. */
export interface XtreamAccount {
  status: string;
  expiresAt?: number;
  maxConnections?: number;
  activeConnections?: number;
  isTrial: boolean;
  outputFormats: string[];
  serverTimezone?: string;
}

/** A live, movie or series category. */
export interface XtreamCategory {
  id: string;
  name: string;
  parentId?: string;
}

/** A live channel; `added` is epoch milliseconds. */
export interface XtreamLive {
  id: number;
  num?: number;
  name: string;
  categoryIds: string[];
  icon?: string;
  epgId?: string;
  catchupDays: number;
  added?: number;
}

/** A movie; one record per id with every category it belongs to. */
export interface XtreamMovie {
  id: number;
  name: string;
  categoryIds: string[];
  icon?: string;
  rating?: number;
  year?: number;
  extension: string;
  added?: number;
}

/** A series; one record per id with every category it belongs to. `lastModified` is epoch milliseconds. */
export interface XtreamSeries {
  id: number;
  name: string;
  categoryIds: string[];
  cover?: string;
  plot?: string;
  rating?: number;
  year?: number;
  lastModified?: number;
}

/** One episode of a series. */
export interface XtreamEpisode {
  id: number;
  season: number;
  episode: number;
  title: string;
  extension: string;
  durationSec?: number;
}

/** Seasons and the flat, sorted episode list of a series. */
export interface XtreamSeriesInfo {
  seasons: number[];
  episodes: XtreamEpisode[];
}

/** Details of one movie. */
export interface XtreamVodInfo {
  durationSec?: number;
  plot?: string;
  year?: number;
  extension: string;
}

/** A short-EPG entry with epoch-millisecond times. */
export interface XtreamEpgEntry {
  start: number;
  stop: number;
  title: string;
  desc?: string;
}

/** Per-call options of every {@link XtreamClient} method. */
export interface XtreamCallOptions {
  /** Aborting ends the call with `network` / `aborted`, also while the body is streaming. */
  signal?: AbortSignal;
}

/** Per-call options of streaming {@link XtreamClient} list methods. */
export interface XtreamStreamOptions extends XtreamCallOptions {
  /** Maximum records yielded per batch (default 500). */
  batchSize?: number;
}

/** Per-host token-bucket pacing options for {@link createXtreamClient}. */
export interface XtreamRateLimitOptions {
  burst?: number;
  ratePerSec?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Options for {@link createXtreamClient}. */
export interface XtreamClientOptions {
  http: HttpClient;
  /** Panel address. A value without `://` gets `http://` prepended. */
  server: string;
  /** Optional ordered failover mirrors used on network or 5xx failures (never on 429 or auth errors). */
  backupServers?: readonly string[];
  /** Milliseconds to stay on a healthy mirror before probing the primary server again (default 300_000). */
  primaryCooldownMs?: number;
  /** Fallback account-scoped cooldown in ms after an HTTP 429 without a `Retry-After` header (default 60_000). */
  cooldown429Ms?: number;
  /** Optional IANA timezone (e.g. `Europe/Berlin`) used for short-EPG datetime/codepage fallback before `account()` runs. */
  serverTimezone?: string;
  /** Largest response body read into memory (default 128 MiB); bigger ones fail with `source-format` / `too-large`. */
  maxBodyBytes?: number;
  username: string;
  password: string;
  transport?: TransportSettings;
  /** Monotonic-clock per-host token bucket options (`false` disables pacing). */
  rateLimit?: XtreamRateLimitOptions | false;
}

/** Typed access to an Xtream-style panel. Credentials stay inside the client. */
export interface XtreamClient {
  account(options?: XtreamCallOptions): Promise<Result<XtreamAccount>>;
  categories(
    kind: 'live' | 'movie' | 'series',
    options?: XtreamCallOptions,
  ): Promise<Result<XtreamCategory[]>>;
  /** Pass `categoryId` to bound the size of one call. */
  liveStreams(categoryId?: string, options?: XtreamCallOptions): Promise<Result<XtreamLive[]>>;
  vodStreams(categoryId?: string, options?: XtreamCallOptions): Promise<Result<XtreamMovie[]>>;
  series(categoryId?: string, options?: XtreamCallOptions): Promise<Result<XtreamSeries[]>>;
  /** Incrementally streams live channels in bounded-memory batches. */
  streamLiveStreams(
    categoryId?: string,
    options?: XtreamStreamOptions,
  ): AsyncGenerator<XtreamLive[], Result<void>>;
  /** Incrementally streams movies in bounded-memory batches. */
  streamVodStreams(
    categoryId?: string,
    options?: XtreamStreamOptions,
  ): AsyncGenerator<XtreamMovie[], Result<void>>;
  /** Incrementally streams series in bounded-memory batches. */
  streamSeries(
    categoryId?: string,
    options?: XtreamStreamOptions,
  ): AsyncGenerator<XtreamSeries[], Result<void>>;
  seriesInfo(seriesId: number, options?: XtreamCallOptions): Promise<Result<XtreamSeriesInfo>>;
  vodInfo(vodId: number, options?: XtreamCallOptions): Promise<Result<XtreamVodInfo>>;
  shortEpg(
    streamId: number,
    limit?: number,
    options?: XtreamCallOptions,
  ): Promise<Result<XtreamEpgEntry[]>>;
  /** M3U playlist URL for the scanner; contains the credentials. */
  playlistUrl(): string;
  /** XMLTV guide URL for the scanner; contains the credentials. */
  guideUrl(): string;
  /** Playback URL built at play time; contains the credentials and is never stored. */
  streamUrl(kind: ContentKind, id: number, extension?: string): string;
}

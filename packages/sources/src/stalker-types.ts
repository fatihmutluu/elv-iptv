import type { HttpClient, Result, TransportSettings } from '@elv/domain';

/** Normalized Stalker/Ministra portal API endpoint with optional 404 fallback endpoint. */
export interface StalkerPortalEndpoint {
  /** Primary API load endpoint (`.../portal.php` or `.../server/load.php`). */
  endpoint: string;
  /** Optional fallback endpoint probed once on HTTP 404 during handshake. */
  fallbackEndpoint?: string;
}

/** Per-call options accepted by every {@link StalkerClient} method. */
export interface StalkerCallOptions {
  /** Aborting ends the call with `network` / `aborted`. */
  signal?: AbortSignal;
}

/** Options for paginated live channel listings. */
export interface StalkerLiveListOptions extends StalkerCallOptions {
  genreId?: string;
  page?: number;
}

/** Options for paginated VOD or series listings. */
export interface StalkerCategoryListOptions extends StalkerCallOptions {
  categoryId?: string;
  page?: number;
}

/** Content kind passed to `createLink`. */
export type StalkerLinkKind = 'live' | 'movie' | 'series';

/** Options for play-time `create_link` resolution. */
export interface StalkerCreateLinkOptions extends StalkerCallOptions {
  /** 1-based episode number required by some portals for series `create_link`. */
  episodeNumber?: number;
}

/** Options for {@link createStalkerClient}. */
export interface StalkerClientOptions {
  http: HttpClient;
  /** Portal URL (`http(s)://host[:port]`, `.../c/`, `.../portal.php`, or `.../server/load.php`). */
  portalUrl: string;
  /** Device MAC address validated via `normalizeMacAddress` (`AA:BB:CC:DD:EE:FF`). */
  mac: string;
  /** Optional device serial number (`sn`), kept strictly inside the client closure. */
  serialNumber?: string;
  /** Optional IANA timezone for the `Cookie` header and EPG fallback (default `'UTC'`). */
  timezone?: string;
  /** Optional STB language for the `Cookie` header (default `'en'`). */
  language?: string;
  /** Per-source transport settings (headers, `allowLegacyTls`, `dnsFamily`, `hostOverride`). */
  transport?: TransportSettings;
  /** Largest response body read into memory (default 32 MiB); bigger fails with `source-format` / `too-large`. */
  maxBodyBytes?: number;
  /** Per-request header timeout in ms (default 30_000). */
  timeoutMs?: number;
}

/** Account profile returned by `type=stb&action=get_profile`. */
export interface StalkerProfile {
  status: string;
  expiresAt?: number;
  maxConnections?: number;
  timezone?: string;
  blocked: boolean;
}

/** A live genre, VOD category, or series category. */
export interface StalkerCategory {
  id: string;
  title: string;
  alias?: string;
  censored?: boolean;
}

/** A single page returned by `get_ordered_list`. */
export interface StalkerPage<T> {
  items: T[];
  totalItems: number;
  maxPageItems: number;
  page: number;
}

/** A live TV channel from a Stalker/Ministra portal. */
export interface StalkerChannel {
  id: string;
  number?: number;
  name: string;
  genreId?: string;
  cmd: string;
  logo?: string;
  epgId?: string;
  catchupDays: number;
  censored?: boolean;
}

/** A VOD movie item from a Stalker/Ministra portal. */
export interface StalkerVodItem {
  id: string;
  name: string;
  categoryId?: string;
  cmd: string;
  cover?: string;
  rating?: number;
  year?: number;
  plot?: string;
  cast?: string;
  director?: string;
  durationSec?: number;
  addedAt?: number;
  isSeries?: boolean;
  censored?: boolean;
}

/** A series item from a Stalker/Ministra portal. */
export interface StalkerSeriesItem {
  id: string;
  name: string;
  categoryId?: string;
  cover?: string;
  rating?: number;
  year?: number;
  plot?: string;
  cast?: string;
  director?: string;
  addedAt?: number;
  censored?: boolean;
}

/** A season within a Stalker/Ministra series. */
export interface StalkerSeason {
  id: string;
  seriesId: string;
  seasonNumber: number;
  name: string;
  cmd?: string;
  seriesEpisodeNumbers?: number[];
}

/** An episode within a Stalker/Ministra season. */
export interface StalkerEpisode {
  id: string;
  seriesId: string;
  seasonId: string;
  episodeNumber: number;
  title: string;
  cmd: string;
  durationSec?: number;
}

/** A portal EPG programme entry with epoch-millisecond timestamps. */
export interface StalkerEpgEntry {
  start: number;
  stop: number;
  title: string;
  desc?: string;
}

/**
 * Credential-isolated client for a Stalker/Ministra MAC portal.
 * Portal URL, MAC address, serial number, and bearer tokens stay strictly inside the closure.
 */
export interface StalkerClient {
  handshake(options?: StalkerCallOptions): Promise<Result<void>>;
  profile(options?: StalkerCallOptions): Promise<Result<StalkerProfile>>;
  genres(options?: StalkerCallOptions): Promise<Result<StalkerCategory[]>>;
  vodCategories(options?: StalkerCallOptions): Promise<Result<StalkerCategory[]>>;
  seriesCategories(options?: StalkerCallOptions): Promise<Result<StalkerCategory[]>>;
  liveChannels(options?: StalkerLiveListOptions): Promise<Result<StalkerPage<StalkerChannel>>>;
  allLiveChannels(options?: StalkerCallOptions): Promise<Result<StalkerChannel[]>>;
  vodItems(options?: StalkerCategoryListOptions): Promise<Result<StalkerPage<StalkerVodItem>>>;
  seriesItems(
    options?: StalkerCategoryListOptions,
  ): Promise<Result<StalkerPage<StalkerSeriesItem>>>;
  seriesSeasons(seriesId: string, options?: StalkerCallOptions): Promise<Result<StalkerSeason[]>>;
  seasonEpisodes(
    seriesId: string,
    seasonId: string,
    page?: number,
    options?: StalkerCallOptions,
  ): Promise<Result<StalkerPage<StalkerEpisode>>>;
  shortEpg(
    channelId: string,
    size?: number,
    options?: StalkerCallOptions,
  ): Promise<Result<StalkerEpgEntry[]>>;
  epgInfo(
    periodHours?: number,
    options?: StalkerCallOptions,
  ): Promise<Result<Record<string, StalkerEpgEntry[]>>>;
  createLink(
    kind: StalkerLinkKind,
    cmd: string,
    options?: StalkerCreateLinkOptions,
  ): Promise<Result<string>>;
}

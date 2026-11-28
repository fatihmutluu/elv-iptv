import type { HttpClient, Result, TransportSettings } from '@elv/domain';

/** Observed authentication mode of a Stalker/Ministra portal endpoint. */
export type StalkerPortalMode = 'simple' | 'full';

/** Discovered active endpoint and authentication mode for a Stalker/Ministra portal. */
export interface StalkerDiscoveredPortal {
  readonly endpoint: string;
  readonly mode: StalkerPortalMode;
}

/** Normalized Stalker/Ministra portal API endpoint with ordered candidate endpoints. */
export interface StalkerPortalEndpoint {
  /** Primary API load endpoint (`.../portal.php`, `.../server/load.php`, or explicit `.php`). */
  endpoint: string;
  /** Optional second candidate endpoint probed after primary. */
  fallbackEndpoint?: string;
  /** Deduplicated ordered list of candidate API endpoints derived from the user's portal URL. */
  readonly candidates?: readonly string[];
}

/** Per-call options accepted by every {@link StalkerClient} method. */
export interface StalkerCallOptions {
  /** Aborting ends the call with `network` / `aborted`. */
  signal?: AbortSignal;
}

/** Options for series season and episode listing calls (supports `type=vod` Ministra series). */
export interface StalkerSeriesCallOptions extends StalkerCallOptions {
  /** Portal content type for series endpoints (default `'series'`; use `'vod'` for VOD-backed series). */
  contentType?: 'series' | 'vod';
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
  /** 1-based episode number required by portals for embedded series `create_link`. */
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
  /** Optional STB `device_id` sent on `get_profile` / `do_auth` (never auto-invented). */
  deviceId?: string;
  /** Optional STB `device_id2` sent on `get_profile` / `do_auth` (never auto-invented). */
  deviceId2?: string;
  /** Optional STB `signature` sent on `get_profile`. */
  signature?: string;
  /** Optional portal account login for `status=2` second-step `do_auth`. */
  login?: string;
  /** Optional portal account password for `status=2` second-step `do_auth`. */
  password?: string;
  /** Previously discovered API endpoint to use directly before falling back to discovery. */
  discoveredEndpoint?: string;
  /** Previously discovered authentication mode (`'simple'` token-free or `'full'` bearer token). */
  portalMode?: StalkerPortalMode;
  /** Optional IANA or fixed-offset timezone for the `Cookie` header and EPG fallback (default `'UTC'`). */
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
  /** Portal watchdog polling interval in seconds (`watchdog_timeout`), when reported. */
  watchdogTimeoutSec?: number;
  blocked: boolean;
}

/** Keepalive response returned by `type=watchdog&action=get_events`. */
export interface StalkerWatchdogEventResult {
  event?: string;
  watchdogTimeoutSec?: number;
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
  /** Raw `use_http_tmp_link` flag when explicitly reported by the portal. */
  useHttpTmpLink?: boolean;
  /** Raw `use_load_balancing` flag when explicitly reported by the portal. */
  useLoadBalancing?: boolean;
}

/** A VOD movie or VOD-backed series item from a Stalker/Ministra portal. */
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
  /** Embedded 1-based episode numbers (`series: [1, 2, ...]`) when directly attached to a VOD row. */
  seriesEpisodeNumbers?: readonly number[];
  censored?: boolean;
  /** Raw `use_http_tmp_link` flag when explicitly reported by the portal. */
  useHttpTmpLink?: boolean;
  /** Raw `use_load_balancing` flag when explicitly reported by the portal. */
  useLoadBalancing?: boolean;
}

/** A series item from a Stalker/Ministra portal. */
export interface StalkerSeriesItem {
  id: string;
  name: string;
  categoryId?: string;
  cmd?: string;
  seriesEpisodeNumbers?: readonly number[];
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
  protocol?: string;
  isFile?: boolean;
  fileType?: string;
}

/** A Ministra media file entry returned by `type=vod&action=get_ordered_list&movie_id=...&season_id=...&episode_id=...`. */
export interface StalkerEpisodeFile {
  id: string;
  cmd?: string;
  protocol?: string;
  isFile?: boolean;
  fileType?: string;
  name?: string;
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
  /** Returns the discovered active API endpoint and auth mode once resolved. */
  discoveredPortal(): StalkerDiscoveredPortal | undefined;
  /**
   * Builds lower-case playback headers for `streamUrl`. Applies `streamTransportHeaders` and
   * attaches portal session headers (`cookie`, `authorization`, `user-agent`, `x-user-agent`, `sn`)
   * only when `streamUrl` targets the same normalized host with no `https -> http` downgrade.
   */
  playbackHeadersFor(streamUrl: string): Record<string, string>;
  handshake(options?: StalkerCallOptions): Promise<Result<void>>;
  profile(options?: StalkerCallOptions): Promise<Result<StalkerProfile>>;
  watchdogEvents(options?: StalkerCallOptions): Promise<Result<StalkerWatchdogEventResult>>;
  genres(options?: StalkerCallOptions): Promise<Result<StalkerCategory[]>>;
  vodCategories(options?: StalkerCallOptions): Promise<Result<StalkerCategory[]>>;
  seriesCategories(options?: StalkerCallOptions): Promise<Result<StalkerCategory[]>>;
  liveChannels(options?: StalkerLiveListOptions): Promise<Result<StalkerPage<StalkerChannel>>>;
  allLiveChannels(options?: StalkerCallOptions): Promise<Result<StalkerChannel[]>>;
  vodItems(options?: StalkerCategoryListOptions): Promise<Result<StalkerPage<StalkerVodItem>>>;
  seriesItems(
    options?: StalkerCategoryListOptions,
  ): Promise<Result<StalkerPage<StalkerSeriesItem>>>;
  seriesSeasons(
    seriesId: string,
    options?: StalkerSeriesCallOptions,
  ): Promise<Result<StalkerSeason[]>>;
  seasonEpisodes(
    seriesId: string,
    seasonId: string,
    page?: number,
    options?: StalkerSeriesCallOptions,
  ): Promise<Result<StalkerPage<StalkerEpisode>>>;
  vodEpisodeFiles(
    seriesId: string,
    seasonId: string,
    episodeId: string,
    options?: StalkerCallOptions,
  ): Promise<Result<StalkerEpisodeFile[]>>;
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

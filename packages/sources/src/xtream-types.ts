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

/** Options for {@link createXtreamClient}. */
export interface XtreamClientOptions {
  http: HttpClient;
  server: string;
  username: string;
  password: string;
  transport?: TransportSettings;
}

/** Typed access to an Xtream-style panel. Credentials stay inside the client. */
export interface XtreamClient {
  account(): Promise<Result<XtreamAccount>>;
  categories(kind: 'live' | 'movie' | 'series'): Promise<Result<XtreamCategory[]>>;
  /** Pass `categoryId` to bound the size of one call. */
  liveStreams(categoryId?: string): Promise<Result<XtreamLive[]>>;
  vodStreams(categoryId?: string): Promise<Result<XtreamMovie[]>>;
  series(categoryId?: string): Promise<Result<XtreamSeries[]>>;
  seriesInfo(seriesId: number): Promise<Result<XtreamSeriesInfo>>;
  vodInfo(vodId: number): Promise<Result<XtreamVodInfo>>;
  shortEpg(streamId: number, limit?: number): Promise<Result<XtreamEpgEntry[]>>;
  /** M3U playlist URL for the scanner; contains the credentials. */
  playlistUrl(): string;
  /** XMLTV guide URL for the scanner; contains the credentials. */
  guideUrl(): string;
  /** Playback URL built at play time; contains the credentials and is never stored. */
  streamUrl(kind: ContentKind, id: number, extension?: string): string;
}

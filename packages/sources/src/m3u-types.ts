import type { ScanStats } from './stats';

/** What kind of content a playlist entry most likely is. */
export type KindHint = 'live' | 'movie' | 'episode';

/** Catch-up settings from `catchup`, `catchup-source` and `catchup-days`. */
export interface M3uCatchup {
  type: string;
  source?: string;
  days?: number;
}

/** One playlist entry; the URL is kept as written (relative ones resolved when a base URL is given). */
export interface M3uEntry {
  name: string;
  url: string;
  duration: number;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  chno?: number;
  shiftHours?: number;
  groups: string[];
  radio: boolean;
  catchup?: M3uCatchup;
  timeshiftDays?: number;
  recordDays?: number;
  headers: { userAgent?: string; referer?: string; other: Record<string, string> };
  kodiProps: Record<string, string>;
  extra: Record<string, string>;
  kindHint: KindHint;
  nonHttp: boolean;
}

/** The `#EXTM3U` line: guide URLs and every other attribute. */
export interface M3uHeader {
  guideUrls: string[];
  attrs: Record<string, string>;
}

/** A group of entries; the final batch has `done: true` plus the header and statistics. */
export interface M3uBatch {
  entries: M3uEntry[];
  header?: M3uHeader;
  stats?: ScanStats;
  done: boolean;
}

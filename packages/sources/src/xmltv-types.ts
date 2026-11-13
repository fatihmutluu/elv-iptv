import type { Decompressor } from '@elv/domain';
import type { ScanStats } from './stats';

/** A guide channel. */
export interface XmltvChannel {
  id: string;
  names: string[];
  icon?: string;
}

/** A guide programme; times are epoch milliseconds. A programme without a `title` element has `title: ''`. */
export interface XmltvProgramme {
  channel: string;
  start: number;
  stop?: number;
  title: string;
  subTitle?: string;
  desc?: string;
  categories: string[];
  episodeNum?: string;
  icon?: string;
}

/** One batch of a scan; the last one has `done: true` and the statistics. */
export interface XmltvBatch {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  stats?: ScanStats;
  done: boolean;
}

/** Options of `scanXmltv`. */
export interface XmltvOptions {
  /** Programmes per batch (default 500). */
  batchSize?: number;
  /** Keep only these channel ids (channels and programmes). */
  channels?: ReadonlySet<string>;
  /** Drop programmes that end at or before this instant (epoch ms). */
  from?: number;
  /** Drop programmes that start at or after this instant (epoch ms). */
  to?: number;
  /** Required for gzip input. */
  decompressor?: Decompressor;
}

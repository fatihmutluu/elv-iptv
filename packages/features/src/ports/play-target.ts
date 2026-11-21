import type { UserItemKind } from '@elv/data';

/** Metadata needed to tune and title a playable live channel, movie, or episode. */
export interface PlayableEntry {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly title: string;
  readonly kind: 'live' | 'vod';
  readonly startPositionMs?: number;
  readonly logo?: string | null;
  readonly subtitle?: string | null;
  readonly seriesKey?: string | null;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly itemKind?: UserItemKind;
}

/** Channel list context enabling Up/Down live zapping across paged categories without materializing all rows. */
export interface LiveChannelPlaylist {
  readonly count: number;
  readonly currentIndex: number;
  getAt(index: number): Promise<PlayableEntry | undefined>;
  onChangeIndex(index: number): void;
}

/** Active item handed to `PlayerScreen`. */
export interface PlayTarget extends PlayableEntry {
  readonly playlist?: LiveChannelPlaylist;
  readonly nextEpisodes?: readonly PlayableEntry[];
  readonly previousChannel?: PlayableEntry;
  readonly previousChannelIndex?: number;
}

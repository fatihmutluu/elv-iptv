import type { UserItemKind } from '@elv/data';

/** Optional catch-up archive playback metadata attached to a {@link PlayableEntry} (`#27`). */
export interface PlayableCatchupMeta {
  readonly startMs: number;
  readonly stopMs: number;
  readonly programmeTitle: string;
  readonly hasArchive?: boolean;
  readonly liveTarget: PlayableEntry;
}

/** Metadata needed to tune and title a playable live channel, movie, or episode. */
export interface PlayableEntry {
  readonly itemKey: string;
  readonly sourceId: string;
  /** Cross-source credential pool key (`fp:...`) when available; falls back to `sourceId` (#265). */
  readonly accountKey?: string;
  readonly title: string;
  readonly kind: 'live' | 'vod';
  readonly startPositionMs?: number;
  readonly logo?: string | null;
  readonly subtitle?: string | null;
  readonly seriesKey?: string | null;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly itemKind?: UserItemKind;
  /** Optional live category ID (`sourceId|live|providerId`) for same-category variant switching (`#218`). */
  readonly categoryId?: string;
  /** Optional pre-play preferred audio language code (e.g. `'tr'`, `'en'`) (`#398`). */
  readonly preferredAudioLang?: string;
  /** Optional pre-play preferred subtitle language code (e.g. `'tr'`, `'en'`, `'off'`) (`#398`). */
  readonly preferredSubtitleLang?: string;
  /** Present when playing a past programme via provider catch-up archive (`#27`). */
  readonly catchup?: PlayableCatchupMeta;
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

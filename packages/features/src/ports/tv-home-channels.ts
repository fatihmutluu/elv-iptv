/** Kind of media item surfaced in an Android TV Home Screen preview channel (`#273`). */
export type TvHomeProgramKind = 'live' | 'movie' | 'episode';

/** Single preview program entry handed to the Android TV Home Screen provider. */
export interface TvHomeChannelProgram {
  readonly itemKey: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly kind: TvHomeProgramKind;
  readonly logoUrl?: string;
  readonly durationMs?: number;
  readonly lastPlaybackPositionMs?: number;
  readonly isLive?: boolean;
}

/** Bounded Android TV Home Screen preview channel payload (`#273`). */
export interface TvHomeChannelDescriptor {
  readonly internalId: 'continue_watching' | 'favorites';
  readonly displayName: string;
  readonly isDefaultBrowsable?: boolean;
  readonly programs: readonly TvHomeChannelProgram[];
}

/** Result of syncing Android TV Home Screen preview channels. */
export interface TvHomeChannelsSyncSummary {
  readonly supported: boolean;
  readonly syncedChannels: number;
  readonly syncedPrograms: number;
}

/**
 * Platform port for syncing Android TV Home Screen preview channels (`#273`).
 * Implemented via `@elv/tv-home-channels` on Android TV; omitted or no-op on other platforms.
 */
export interface TvHomeChannelsPort {
  isSupported(): boolean;
  syncChannels(channels: readonly TvHomeChannelDescriptor[]): Promise<TvHomeChannelsSyncSummary>;
  clearChannels(): Promise<void>;
}

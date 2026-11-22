import type { PlayerEngine } from '@elv/playback';
import type { ReactElement } from 'react';

/** Props passed to the platform video surface rendered underneath or alongside the OSD. */
export interface VideoSurfaceProps {
  statusText: string;
  failed: boolean;
  /** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover). */
  resizeMode?: 'fit' | 'fill';
  /** Extra bottom inset in dp/px to lift native subtitles above a visible OSD (`#136`). */
  subtitleBottomInsetPx?: number;
  testID?: string;
}

/** Key action forwarded from an out-of-DOM native video window (such as desktop mpv) into the renderer (`#420`). */
export type HostKey =
  | 'channel-up'
  | 'channel-down'
  | 'back'
  | 'fullscreen'
  | 'play-pause'
  | 'seek-back'
  | 'seek-forward'
  | 'seek-coarse-back'
  | 'seek-coarse-forward'
  | 'mute'
  | 'tracks'
  | 'prev-channel';

/** Typed playback metadata pushed from `PlayerScreen` to OS media controls (`MediaSession`, `#435`). */
export interface MediaSessionMetadata {
  readonly title: string;
  readonly subtitle?: string;
  readonly artworkUrl?: string;
  readonly kind: 'live' | 'vod';
  /** Whether previous/next track stepping (live playlist or episode queue) is available. */
  readonly canStepTrack: boolean;
}

/** An opened platform player engine paired with its view surface renderer. */
export interface OpenVideoEngine {
  readonly engine: PlayerEngine;
  renderSurface(props: VideoSurfaceProps): ReactElement | null;
  /** Optional key stream emitted by an out-of-DOM video window (such as desktop mpv). */
  onHostKey?: (listener: (key: HostKey) => void) => () => void;
  /** Optional host fullscreen toggle (e.g. desktop presenter window fullscreen). */
  toggleFullscreen?: () => void;
  /** Optional host audio mute toggle. */
  toggleMute?: () => void;
  /** Optional native screen-orientation lock toggle for touch lock (`#440`). */
  setOrientationLocked?: (locked: boolean) => void;
  /** Optional per-stream deinterlace toggle (e.g. desktop mpv interlaced broadcast support, `#131`). */
  setDeinterlace?: (enabled: boolean) => void;
  /** Optional typed media metadata sink for OS media session integrations (`#435`). */
  setMediaMetadata?: (metadata: MediaSessionMetadata | null) => void;
}

/** Port supplied by the app composition root to open a `PlayerEngine` and render its surface. */
export interface VideoHost {
  open(): OpenVideoEngine | null | Promise<OpenVideoEngine | null>;
}

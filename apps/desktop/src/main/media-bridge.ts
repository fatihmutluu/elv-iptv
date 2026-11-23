import type { DesktopMediaMetadata } from '../shared/player-ipc.ts';

/** Playback status mirrored to OS media integrations (Linux MPRIS2 / macOS Now Playing). */
export type DesktopMediaPlaybackStatus = 'Playing' | 'Paused' | 'Stopped';

/** Transport commands delivered from OS media integrations back to the active desktop player. */
export type DesktopMediaCommand =
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'togglePlayPause' }
  | { readonly type: 'stop' }
  | { readonly type: 'next' }
  | { readonly type: 'previous' }
  | { readonly type: 'seekByUs'; readonly offsetUs: number }
  | { readonly type: 'seekToUs'; readonly positionUs: number }
  | { readonly type: 'setRate'; readonly rate: number }
  | { readonly type: 'setVolume'; readonly volume: number };

/** Snapshot of active playback state pushed from main player IPC to OS media bridges. */
export interface DesktopMediaStateSnapshot {
  readonly status: DesktopMediaPlaybackStatus;
  /** True while transitioning/loading/buffering between items so MPRIS2 avoids flashing `Stopped`. */
  readonly isNavigating: boolean;
  readonly kind: 'live' | 'vod';
  readonly positionUs: number;
  readonly durationUs: number;
  readonly rate: number;
  /** Normalized `[0, 1]` volume (`1.0` = 100%). */
  readonly volume: number;
  readonly metadata: DesktopMediaMetadata | null;
}

/** Shared main-process interface implemented by Linux MPRIS2 (`#238`) and macOS MediaPlayer (`#301`). */
export interface DesktopMediaBridge {
  /** Updates the bridge with the latest playback state, position, rate, volume, and metadata. */
  updateState(snapshot: DesktopMediaStateSnapshot): void;
  /** Notifies the bridge of an explicit seek jump (e.g. for MPRIS2 `Seeked` signal). */
  notifySeeked?(positionUs: number): void;
  /** Subscribes to OS-initiated transport commands; returns unsubscribe. */
  onCommand(listener: (command: DesktopMediaCommand) => void): () => void;
  /** Tears down OS registrations, sockets, and timers cleanly. */
  dispose(): void;
}

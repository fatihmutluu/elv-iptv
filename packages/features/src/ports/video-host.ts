import type { PlayerEngine } from '@elv/playback';
import type { ReactElement } from 'react';

/** Props passed to the platform video surface rendered underneath or alongside the OSD. */
export interface VideoSurfaceProps {
  statusText: string;
  failed: boolean;
  testID?: string;
}

/** An opened platform player engine paired with its view surface renderer. */
export interface OpenVideoEngine {
  readonly engine: PlayerEngine;
  renderSurface(props: VideoSurfaceProps): ReactElement | null;
  /** Optional channel-key stream emitted by an out-of-DOM video window (such as desktop mpv). */
  onHostKey?: (listener: (key: 'channel-up' | 'channel-down') => void) => () => void;
}

/** Port supplied by the app composition root to open a `PlayerEngine` and render its surface. */
export interface VideoHost {
  open(): OpenVideoEngine | null | Promise<OpenVideoEngine | null>;
}

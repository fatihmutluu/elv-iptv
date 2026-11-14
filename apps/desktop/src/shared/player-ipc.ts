import type { EngineCapabilities } from '@elv/playback';

/** The player area in CSS pixels of the app window's content, and whether video should show there. */
export interface PlayerArea {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** How mpv's picture reaches the screen: a child window kept on the player area, or mpv's own window. */
export type PresenterKind = 'child-window' | 'own-window';

/**
 * What the desktop mpv engine can do in 0.1: no live seek, no software-audio rung (FFmpeg already decodes audio in
 * software), no track selection yet (mpv's OSC handles tracks until the port has track commands).
 */
export const DESKTOP_CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: false,
  recreate: true,
  audioTrackSelection: false,
  subtitleTrackSelection: false,
});

/** Presentation events outside the port, main to renderer (`player:ui`). */
export type PlayerUiEvent =
  | { type: 'presenter'; kind: PresenterKind; coversArea: boolean }
  | { type: 'key'; key: 'channel-up' | 'channel-down' | 'back' | 'fullscreen' | 'close' }
  | { type: 'closed' };

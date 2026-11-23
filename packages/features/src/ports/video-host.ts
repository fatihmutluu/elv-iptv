import type { AccessibilityFontFamily, DeinterlaceMode } from '@elv/domain';
import type { PlayerEngine, StreamRequest } from '@elv/playback';
import type { ReactElement } from 'react';

/** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover, `stretch` fills bounds ignoring aspect). */
export type VideoResizeMode = 'fit' | 'fill' | 'stretch';

/** Payload queued onto a gapless host engine for the next series episode (`#205`). */
export interface QueuedEpisodeHostRequest {
  readonly itemKey: string;
  readonly stream: StreamRequest;
  readonly preferHevcOverDolbyVision?: boolean;
  readonly filterSdhSubtitles?: boolean;
}

/** Props passed to the platform video surface rendered underneath or alongside the OSD. */
export interface VideoSurfaceProps {
  statusText: string;
  failed: boolean;
  /** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover, `stretch` fills bounds ignoring aspect). */
  resizeMode?: VideoResizeMode;
  /** Extra bottom inset in dp/px to lift native subtitles above a visible OSD (`#136`). */
  subtitleBottomInsetPx?: number;
  /** Preferred high-legibility subtitle typeface (`#163`). */
  subtitleFontFamily?: AccessibilityFontFamily;
  /** Monotonic token incremented on Rung 3 decoder reset to swap in a fresh native surface (`#144`). */
  surfaceRecreationToken?: number;
  /** Opt-in TextureView fallback on Android devices with broken SurfaceView compositing (`#262`). */
  useTextureView?: boolean;
  /** Whether the player OSD is currently visible so native engines can throttle hidden-OSD clock updates (`#442`). */
  osdVisible?: boolean;
  testID?: string;
}

/** Key action forwarded from an out-of-DOM native video window (such as desktop mpv) into the renderer (`#420`). */
export type HostKey =
  | 'channel-up'
  | 'channel-down'
  | 'back'
  | 'stop'
  | 'fullscreen'
  | 'play-pause'
  | 'seek-back'
  | 'seek-forward'
  | 'seek-coarse-back'
  | 'seek-coarse-forward'
  | 'mute'
  | 'tracks'
  | 'prev-channel'
  | 'info'
  | 'channel-list'
  | 'always-on-top'
  | 'aspect'
  | 'volume-up'
  | 'volume-down';

/** Output audio device descriptor exposed by a host player engine (e.g. desktop `libmpv`, `#408`). */
export interface AudioDeviceInfo {
  readonly name: string;
  readonly description: string;
}

/** Typed playback metadata pushed from `PlayerScreen` to OS media controls (`MediaSession`, `#435`). */
export interface MediaSessionMetadata {
  readonly title: string;
  readonly subtitle?: string;
  readonly artworkUrl?: string;
  readonly kind: 'live' | 'vod';
  /** Whether previous/next track stepping (live playlist or episode queue) is available. */
  readonly canStepTrack: boolean;
}

/** Axis-locked Siri Remote touch-surface pan event emitted on tvOS (`#225`). */
export interface TvPanGestureEvent {
  readonly axis: 'horizontal' | 'vertical';
  readonly phase: 'began' | 'changed' | 'ended' | 'cancelled';
  readonly translation: number;
  readonly velocity: number;
}

/** An opened platform player engine paired with its view surface renderer. */
export interface OpenVideoEngine {
  readonly engine: PlayerEngine;
  renderSurface(props: VideoSurfaceProps): ReactElement | null;
  /** Optional key stream emitted by an out-of-DOM video window (such as desktop mpv). */
  onHostKey?: (listener: (key: HostKey) => void) => () => void;
  /** Optional host fullscreen toggle (e.g. desktop presenter window fullscreen). */
  toggleFullscreen?: () => void;
  /** Optional current host fullscreen state reader (`#394`). */
  isFullscreen?: () => boolean;
  /** Optional host fullscreen transition subscription (`#394`). */
  onFullscreenChange?: (listener: (fullscreen: boolean) => void) => () => void;
  /** Optional host audio mute toggle. */
  toggleMute?: () => void;
  /** Optional host output volume setter (`0`–`100`, `#394`). */
  setVolume?: (volume: number) => void;
  /** Optional initial host output volume (`0`–`100`, `#394`). */
  initialVolume?: number;
  /** Optional native screen brightness setter (`0`–`1`, `#114`). */
  setBrightness?: (level: number) => void;
  /** Optional native screen-orientation lock toggle for touch lock (`#440`). */
  setOrientationLocked?: (locked: boolean) => void;
  /** Optional temporary sensor-releasing orientation request on mobile (`#266`). */
  requestTemporaryOrientation?: (landscape: boolean) => void;
  /** Optional Picture-in-Picture entry trigger on Android phones/tablets (`#266`). */
  enterPictureInPicture?: (aspectWidth?: number, aspectHeight?: number) => boolean;
  /** Optional Picture-in-Picture mode subscription (`#266`). */
  onPictureInPictureChange?: (listener: (inPip: boolean) => void) => () => void;
  /** Optional per-stream deinterlace toggle (e.g. desktop mpv interlaced broadcast support, `#131`). */
  setDeinterlace?: (enabled: boolean) => void;
  /** Optional typed media metadata sink for OS media session integrations (`#435`). */
  setMediaMetadata?: (metadata: MediaSessionMetadata | null) => void;
  /** Optional desktop window always-on-top pin toggle (`#408`). */
  toggleAlwaysOnTop?: () => void;
  /** Optional current desktop always-on-top state reader (`#408`). */
  isAlwaysOnTop?: () => boolean;
  /** Optional desktop always-on-top transition subscription (`#408`). */
  onAlwaysOnTopChange?: (listener: (pinned: boolean) => void) => () => void;
  /** Optional available output audio devices list (`#408`). */
  getAudioDevices?: () => readonly AudioDeviceInfo[];
  /** Optional active output audio device identifier (`'auto'` for system default, `#408`). */
  getActiveAudioDevice?: () => string;
  /** Optional live output audio device switcher (`#408`). */
  setAudioDevice?: (name: string) => void;
  /** Optional output audio device list/selection change subscription (`#408`). */
  onAudioDevicesChange?: (
    listener: (devices: readonly AudioDeviceInfo[], active: string) => void,
  ) => () => void;
  /** Optional presentation overlay mode (`'floating'` over canvas, `'docked'` around legacy child HWND). */
  readonly overlayMode?: 'floating' | 'docked';
  /** Optional subscription invoked when host switches between `'floating'` and `'docked'` overlay modes. */
  onOverlayModeChange?: (listener: (mode: 'floating' | 'docked') => void) => () => void;
  /** Optional live video aspect/resize mode setter (`#124`). */
  setResizeMode?: (mode: VideoResizeMode) => void;
  /** Optional live SDH subtitle annotation filter toggle (`#310`). */
  setFilterSdh?: (enabled: boolean) => void;
  /** Optional live subtitle typeface setter (e.g. desktop `mpv` `sub-font`, `#163`). */
  readonly setSubtitleFontFamily?: (family: AccessibilityFontFamily) => void;
  /** Optional broadcast deinterlacing mode setter (`'off' | 'auto' | 'bwdif'`, `#243`). */
  readonly setDeinterlaceMode?: (mode: DeinterlaceMode) => void;
  /** Optional audio pitch lock toggle for non-1.0× playback speeds (`#243`, `#264`). */
  readonly setPitchLock?: (locked: boolean) => void;
  /** Optional EBU R128 loudness normalization toggle (`#243`). */
  readonly setAudioNormalization?: (enabled: boolean) => void;
  /** Optional background audio playback toggle for mobile foreground services / audio sessions (`#412`, `#413`). */
  readonly setBackgroundAudioEnabled?: (enabled: boolean) => void;
  /** Optional gapless next-episode queue setter (`#205`). */
  readonly queueNext?: (request: QueuedEpisodeHostRequest) => void;
  /** Optional gapless next-episode queue clearer (`#205`). */
  readonly clearQueue?: () => void;
  /** Optional callback fired when a gapless queued episode becomes active (`#205`). */
  readonly onQueueAdvanced?: (listener: (itemKey: string) => void) => () => void;
  /** Optional tvOS Siri Remote directional pan gesture gate (`#225`). */
  readonly setTvPanGestureEnabled?: (enabled: boolean) => void;
  /** Optional tvOS Siri Remote axis-locked pan gesture subscription (`#225`). */
  readonly onTvPanGesture?: (listener: (event: TvPanGestureEvent) => void) => () => void;
}

/** Port supplied by the app composition root to open a `PlayerEngine` and render its surface. */
export interface VideoHost {
  open(): OpenVideoEngine | null | Promise<OpenVideoEngine | null>;
}

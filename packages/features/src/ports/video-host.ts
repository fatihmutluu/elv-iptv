import type {
  AccessibilityFontFamily,
  DeinterlaceMode,
  NightModeDrcPreset,
  SubtitleStyleConfig,
} from '@elv/domain';
import type {
  DesktopAudioOutputConfig,
  DisplaySyncPolicy,
  ExternalSubtitleTrack,
  MediaTracks,
  MultiViewDeviceCapabilities,
  PlaybackService,
  PlaybackStatus,
  PlayerEngine,
  StreamRequest,
  StreamVideoInfo,
  ThermalState,
} from '@elv/playback';
import type { ReactElement } from 'react';
import type { PlayTarget } from './play-target';

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
  /** User-selected subtitle visual appearance configuration (`#32`). */
  subtitleStyle?: SubtitleStyleConfig;
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
  /** Optional explicit host audio mute setter (`#34` Multi-View single active-audio tile). */
  setMuted?: (muted: boolean) => void;
  /** Optional host primary-engine promotion for Multi-View OS media/taskbar handoff (`#34`). */
  setPrimary?: () => void;
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
  /** Optional Picture-in-Picture entry trigger on Android/Apple (`#34`, `#266`). */
  enterPictureInPicture?: (
    aspectWidth?: number,
    aspectHeight?: number,
    sourceRect?: PipSourceRect,
  ) => boolean;
  /** Optional check indicating whether OS PiP is supported for the active route (`#34`). */
  canStartPictureInPicture?: () => boolean;
  /** Optional OS auto-enter-PiP configuration (`#34`). */
  setAutoEnterPictureInPicture?: (
    enabled: boolean,
    aspectWidth?: number,
    aspectHeight?: number,
    sourceRect?: PipSourceRect,
  ) => boolean | undefined;
  /** Optional Picture-in-Picture mode subscription (`#34`, `#266`). */
  onPictureInPictureChange?: (listener: (inPip: boolean) => void) => () => void;
  /** Optional per-stream deinterlace toggle (e.g. desktop mpv interlaced broadcast support, `#131`). */
  setDeinterlace?: (enabled: boolean) => void;
  /** Optional typed media metadata sink for OS media session integrations (`#435`). */
  setMediaMetadata?: (metadata: MediaSessionMetadata | null) => void;
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
  /** Optional host file picker returning a validated local external subtitle track (`#32`). */
  readonly pickSubtitleFile?: () => Promise<ExternalSubtitleTrack | null>;
  /** Optional Android Night-Mode DRC preset setter (`#115`). */
  readonly setNightModeDrc?: (preset: NightModeDrcPreset) => void;
  /** Optional display auto-frame-rate & HDR matching policy setter (`#116`, `#188`, `#199`, `#214`). */
  readonly setDisplaySync?: (policy: DisplaySyncPolicy) => void;
  /** Optional Desktop audio passthrough / exclusive / AC3 / layout setter (`#213`). */
  readonly setDesktopAudioOutput?: (config: DesktopAudioOutputConfig) => void;
  /** Optional notification fired when Desktop audio passthrough falls back to PCM (`#213`). */
  readonly onPassthroughFallback?: (listener: () => void) => () => void;
  /** Optional host engine identifier for zero-reload cross-window transfer (`Wave P3`). */
  readonly hostEngineId?: string;
  /** Parks the live underlying engine for zero-reload transfer to another window, returning its transfer engine ID (`Wave P3`). */
  readonly parkForTransfer?: () => Promise<string | null>;
}

/** Live playback session handed off in-process between `PlayerScreen` and `MultiViewStage` without reloading (`Wave P3`). */
export interface AdoptedPlaybackSession {
  readonly opened: OpenVideoEngine;
  readonly service: PlaybackService;
  readonly target: PlayTarget;
  readonly muted: boolean;
  readonly volume: number;
  readonly status?: PlaybackStatus;
  readonly tracks?: MediaTracks;
  readonly mediaInfo?: StreamVideoInfo;
}

/** Optional screen-coordinate hint rectangle for OS Picture-in-Picture entry animations (`#34`). */
export interface PipSourceRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Optional per-engine open options supporting concurrent Multi-View tiles (`#34`, `#221`). */
export interface VideoHostOpenOptions {
  /** When `false`, opens an additional engine without tearing down existing engines in the window. */
  readonly replaceExisting?: boolean;
  /** When `false`, engine is secondary (no OS media-control or window aspect hijack). */
  readonly primary?: boolean;
  /** On Android, secondary muted tiles pass `false` so they do not steal `AUDIOFOCUS_GAIN`. */
  readonly handleAudioFocus?: boolean;
  /** Active tile count hint so native loaders can scale RAM buffer targets safely. */
  readonly multiViewTileCount?: number;
}

/** Platform thermal and Multi-View hardware capability port (`#34`, `#232`). */
export interface ThermalDevicePort {
  getThermalState(): ThermalState;
  subscribeThermalState(listener: (state: ThermalState) => void): () => void;
  getMultiViewCapabilities(): MultiViewDeviceCapabilities;
}

/** Port supplied by the app composition root to open a `PlayerEngine` and render its surface. */
export interface VideoHost {
  open(options?: VideoHostOpenOptions): OpenVideoEngine | null | Promise<OpenVideoEngine | null>;
  /** Adopts a parked live engine by ID for zero-reload cross-window handoff (`Wave P3`). */
  adoptEngine?: (engineId: string) => Promise<OpenVideoEngine | null>;
  /** True when the active presenter supports concurrent Multi-View tiles (`#34`). */
  readonly supportsMultiView?: boolean;
}

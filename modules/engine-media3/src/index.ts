import {
  bridgeNativeEngine,
  type EngineCapabilities,
  type EngineEvent,
  type ExternalSubtitleTrack,
  type LoadOptions,
  type NativeEngineHandle,
  type PlayerEngine,
} from '@elv/playback';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { type ComponentType, createElement, type ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** Live subtitle appearance style forwarded to Media3 (`#32`). */
export type Media3SubtitleStyle = NonNullable<LoadOptions['subtitleStyle']>;

/** The JS clock of React Native and Node; declared here because the package compiles without DOM types. */
declare const performance: { now(): number };

/** Safe-area edge insets reported by Android `WindowInsetsCompat` (`max(systemBars, displayCutout)` in dp, `#255`). */
export interface AndroidSafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A local playlist file picked through Android Storage Access Framework (`#51`). */
export interface AndroidPickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Typed playback metadata forwarded to Android Media3's `MediaSession` (`#412`). */
export interface AndroidMediaMetadata {
  readonly title: string;
  readonly subtitle?: string;
  readonly artworkUrl?: string;
  readonly kind?: 'live' | 'vod';
  readonly canStepTrack?: boolean;
}

/** Remote media transport action emitted from Android lock-screen / Bluetooth controls (`#412`). */
export type AndroidRemoteMediaAction = 'next' | 'previous' | 'stop';

interface RawPickedPlaylistFile {
  name?: unknown;
  bytes?: unknown;
  base64?: unknown;
}

const ZERO_INSETS: AndroidSafeAreaInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

interface RawInsets {
  top?: unknown;
  right?: unknown;
  bottom?: unknown;
  left?: unknown;
}

interface Media3NativeEngineHandle extends NativeEngineHandle {
  setPitchLock?(locked: boolean): void;
  setAudioDelay?(attempt: number, delayMs: number): void;
  setSubtitleDelay?(attempt: number, delayMs: number): void;
  selectVideoQuality?(attempt: number, id: string | null): void;
  selectSecondarySubtitleTrack?(attempt: number, id: string | null): void;
  addExternalSubtitle?(attempt: number, track: ExternalSubtitleTrack): void;
  setSubtitleStyle?(style: Media3SubtitleStyle): void;
  setMediaMetadata?(metadata: AndroidMediaMetadata | null): void;
  setBackgroundAudioEnabled?(enabled: boolean): void;
  addListener: {
    (eventName: 'onEngineEvent', listener: (event: EngineEvent) => void): { remove(): void };
    (eventName: 'onRemoteMediaAction', listener: (payload: unknown) => void): { remove(): void };
  };
}

interface NativeEngineModule {
  Engine: new () => Media3NativeEngineHandle;
  uptimeMs(): number;
  setOrientationLocked?(locked: boolean): void;
  requestTemporaryOrientation?(landscape: boolean): void;
  applyShortEdgesCutoutMode?(): void;
  getSafeAreaInsets?(): RawInsets | null | undefined;
  enterPictureInPicture?(aspectWidth?: number, aspectHeight?: number): boolean;
  readClipboardText?(): Promise<string | null | undefined>;
  pickPlaylistFile?(): Promise<RawPickedPlaylistFile | null | undefined>;
  addListener?(
    eventName: 'onStandbyChanged' | 'onSafeAreaInsetsChanged' | 'onPictureInPictureChanged',
    listener: (payload: unknown) => void,
  ): { remove(): void };
}

function finiteNonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeInsets(raw: unknown): AndroidSafeAreaInsets {
  if (typeof raw !== 'object' || raw === null) return ZERO_INSETS;
  const r = raw as RawInsets;
  return {
    top: finiteNonNeg(r.top),
    right: finiteNonNeg(r.right),
    bottom: finiteNonNeg(r.bottom),
    left: finiteNonNeg(r.left),
  };
}

function readBooleanField(payload: unknown, key: string): boolean {
  if (typeof payload === 'boolean') return payload;
  if (typeof payload === 'object' && payload !== null && key in payload) {
    return Boolean((payload as Record<string, unknown>)[key]);
  }
  return false;
}

function parseRemoteMediaAction(payload: unknown): AndroidRemoteMediaAction | null {
  const candidate =
    typeof payload === 'string'
      ? payload
      : typeof payload === 'object' && payload !== null && 'action' in payload
        ? (payload as Record<string, unknown>).action
        : null;
  return candidate === 'next' || candidate === 'previous' || candidate === 'stop'
    ? candidate
    : null;
}

const B64_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < 26; i += 1) {
  B64_TABLE[65 + i] = i;
  B64_TABLE[97 + i] = i + 26;
}
for (let i = 0; i < 10; i += 1) B64_TABLE[48 + i] = i + 52;
B64_TABLE[43] = 62;
B64_TABLE[47] = 63;

function decodeBase64(input: string): Uint8Array | null {
  let cleanLen = 0;
  let padding = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 10 || code === 13 || code === 32 || code === 9) continue;
    if (code === 61) {
      padding += 1;
      cleanLen += 1;
      continue;
    }
    if (padding > 0 || code >= 128 || B64_TABLE[code] === -1) return null;
    cleanLen += 1;
  }
  if (cleanLen === 0) return new Uint8Array(0);
  if (cleanLen % 4 !== 0 || padding > 2) return null;
  const out = new Uint8Array((cleanLen / 4) * 3 - padding);
  let outIdx = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 10 || code === 13 || code === 32 || code === 9 || code === 61) continue;
    const val = B64_TABLE[code] ?? -1;
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outIdx < out.length) out[outIdx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function normalizePickedPlaylist(raw: unknown): AndroidPickedPlaylistFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as RawPickedPlaylistFile;
  const name =
    typeof r.name === 'string' && r.name.trim().length > 0 ? r.name.trim() : 'playlist.m3u';
  if (r.bytes instanceof Uint8Array) return { name, bytes: r.bytes };
  if (typeof r.base64 === 'string') {
    const decoded = decodeBase64(r.base64);
    if (decoded !== null) return { name, bytes: decoded };
  }
  return null;
}

const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: true,
  softwareAudioFallback: true,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
  audioDelay: true,
  subtitleDelay: true,
  videoQualitySelection: true,
  externalSubtitles: true,
  subtitleStyling: true,
  dualSubtitles: true,
});

/** The native shared object behind each live engine this module created; `Media3Surface` binds its view to it. */
const handles = new WeakMap<PlayerEngine, Media3NativeEngineHandle>();

function wrap(module: NativeEngineModule): PlayerEngine {
  const native = new module.Engine();
  const bridged = bridgeNativeEngine(native, {
    capabilities: CAPABILITIES,
    uptimeMs: () => module.uptimeMs(),
    now: () => performance.now(),
  });
  let released = false;
  const engine: PlayerEngine = {
    ...bridged,
    ...(native.setPitchLock === undefined
      ? {}
      : {
          setPitchLock(_attempt, locked) {
            if (!released) native.setPitchLock?.(Boolean(locked));
          },
        }),
    ...(bridged.setAudioDelay === undefined && native.setAudioDelay !== undefined
      ? {
          setAudioDelay(attempt, delayMs) {
            if (!released) native.setAudioDelay?.(attempt, delayMs);
          },
        }
      : {}),
    ...(bridged.setSubtitleDelay === undefined && native.setSubtitleDelay !== undefined
      ? {
          setSubtitleDelay(attempt, delayMs) {
            if (!released) native.setSubtitleDelay?.(attempt, delayMs);
          },
        }
      : {}),
    ...(bridged.selectVideoQuality === undefined && native.selectVideoQuality !== undefined
      ? {
          selectVideoQuality(attempt, id) {
            if (!released) native.selectVideoQuality?.(attempt, id);
          },
        }
      : {}),
    release() {
      released = true;
      handles.delete(engine);
      bridged.release();
    },
  };
  handles.set(engine, native);
  return engine;
}

const nativeModule = requireOptionalNativeModule<NativeEngineModule>('ElvEngineMedia3');

/**
 * Creates a Media3 player engine (Android) implementing the `PlayerEngine` port, or returns null where the native
 * module is absent (iOS, web). Each call creates its own native player on its own playback thread; call `release()`
 * when the player screen goes away.
 */
export function createMedia3Engine(): PlayerEngine | null {
  return nativeModule === null ? null : wrap(nativeModule);
}

/** Toggles VOD audio pitch preservation on a live Media3 engine created by {@link createMedia3Engine} (`#264`). */
export function setMedia3PitchLock(engine: PlayerEngine, locked: boolean): void {
  handles.get(engine)?.setPitchLock?.(Boolean(locked));
}

/** Publishes or clears lock-screen / Bluetooth `MediaSession` metadata on a live Media3 engine (`#412`). */
export function setMedia3MediaMetadata(
  engine: PlayerEngine,
  metadata: AndroidMediaMetadata | null,
): void {
  handles.get(engine)?.setMediaMetadata?.(metadata);
}

/** Enables or disables opt-in background audio playback on a live Media3 engine (`#412`). */
export function setMedia3BackgroundAudioEnabled(engine: PlayerEngine, enabled: boolean): void {
  handles.get(engine)?.setBackgroundAudioEnabled?.(Boolean(enabled));
}

/** Subscribes to Android `MediaSession` remote next/previous/stop actions on a live Media3 engine (`#412`). */
export function subscribeMedia3RemoteMediaAction(
  engine: PlayerEngine,
  listener: (action: AndroidRemoteMediaAction) => void,
): () => void {
  const native = handles.get(engine);
  const sub = native?.addListener('onRemoteMediaAction', (payload) => {
    const action = parseRemoteMediaAction(payload);
    if (action !== null) listener(action);
  });
  return () => {
    sub?.remove();
  };
}

/** Locks or unlocks the current Android activity orientation for player touch lock (`#440`). */
export function setOrientationLocked(locked: boolean): void {
  nativeModule?.setOrientationLocked?.(locked);
}

/**
 * Requests a temporary landscape or portrait orientation on Android mobile devices that automatically
 * releases back to sensor control once the device physically rotates into alignment (`#266`).
 */
export function requestTemporaryOrientation(landscape: boolean): void {
  nativeModule?.requestTemporaryOrientation?.(landscape);
}

/** Subscribes to debounced Android TV HDMI-CEC / display standby signals (`#143`). */
export function subscribeAndroidStandby(listener: (standby: boolean) => void): () => void {
  const sub = nativeModule?.addListener?.('onStandbyChanged', (payload) => {
    listener(readBooleanField(payload, 'standby'));
  });
  return () => {
    sub?.remove();
  };
}

/** Applies `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` on non-TV Android API >= 28 (`#255`). */
export function applyAndroidShortEdgesCutoutMode(): void {
  nativeModule?.applyShortEdgesCutoutMode?.();
}

/** Reads current Android safe-area insets (`max(systemBars, displayCutout)` in dp, `#255`). */
export function getAndroidSafeAreaInsets(): AndroidSafeAreaInsets {
  return normalizeInsets(nativeModule?.getSafeAreaInsets?.());
}

/** Subscribes to live Android `WindowInsetsCompat` safe-area inset updates (`#255`). */
export function subscribeAndroidSafeAreaInsets(
  listener: (insets: AndroidSafeAreaInsets) => void,
): () => void {
  const sub = nativeModule?.addListener?.('onSafeAreaInsetsChanged', (payload) => {
    listener(normalizeInsets(payload));
  });
  return () => {
    sub?.remove();
  };
}

/** Requests Android Picture-in-Picture with aspect ratio clamped to Android's safe bounds (`#266`). */
export function enterAndroidPictureInPicture(aspectWidth?: number, aspectHeight?: number): boolean {
  return Boolean(nativeModule?.enterPictureInPicture?.(aspectWidth, aspectHeight));
}

/** Subscribes to Android Picture-in-Picture mode transitions (`#266`). */
export function subscribeAndroidPictureInPicture(listener: (inPip: boolean) => void): () => void {
  const sub = nativeModule?.addListener?.('onPictureInPictureChanged', (payload) => {
    listener(readBooleanField(payload, 'inPip'));
  });
  return () => {
    sub?.remove();
  };
}

/** Reads plain text from the Android system clipboard without requiring any storage permission (`#51`). */
export async function readAndroidClipboardText(): Promise<string | null> {
  const read = nativeModule?.readClipboardText;
  if (typeof read !== 'function') return null;
  try {
    const text = await read();
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Opens Android's Storage Access Framework document picker (`ACTION_OPEN_DOCUMENT`) for a local playlist file
 * (bounded to 64 MiB, zero storage permissions). Returns `null` when cancelled or unavailable (e.g. Android TV) (`#51`).
 */
export async function pickAndroidPlaylistFile(): Promise<AndroidPickedPlaylistFile | null> {
  const pick = nativeModule?.pickPlaylistFile;
  if (typeof pick !== 'function') return null;
  const raw = await pick();
  return normalizePickedPlaylist(raw);
}

/** Props of {@link Media3Surface}. */
export interface Media3SurfaceProps {
  /** An engine from {@link createMedia3Engine}; one surface per engine. */
  engine: PlayerEngine;
  /** Layout only: nothing is painted over the video, so whatever is drawn above the view composes over it. */
  style?: StyleProp<ViewStyle>;
  /**
   * How the picture meets the view: `fit` (the default) shows all of it with black bars beside it,
   * `fill` covers the view and crops the overflow, `stretch` fills the view ignoring aspect ratio.
   */
  resizeMode?: 'fit' | 'fill' | 'stretch';
  /** Extra bottom inset in dp to lift native `SubtitleView` cues above a visible OSD (`#136`). */
  subtitleBottomInsetPx?: number;
  /** High-legibility subtitle font override (`'system'`, `'atkinson'`, or `'opendyslexic'`, `#163`). */
  subtitleFontFamily?: 'system' | 'atkinson' | 'opendyslexic';
  /** Live subtitle appearance styling applied without restarting playback (`#32`). */
  subtitleStyle?: Media3SubtitleStyle;
  /** Monotonic token incremented on Rung 3 decoder reset to swap in a fresh `SurfaceView` (`#144`). */
  surfaceRecreationToken?: number;
  /** Opt-in `TextureView` rendering fallback for devices with broken `SurfaceView` compositing (`#262`). */
  useTextureView?: boolean;
  testID?: string;
}

interface NativeSurfaceProps {
  /** The shared object; expo-modules-core passes it to native as its registry id. */
  engine: NativeEngineHandle;
  style?: StyleProp<ViewStyle>;
  resizeMode?: 'fit' | 'fill' | 'stretch';
  subtitleBottomInsetPx?: number;
  subtitleFontFamily?: 'system' | 'atkinson' | 'opendyslexic';
  subtitleStyle?: Media3SubtitleStyle;
  surfaceRecreationToken?: number;
  useTextureView?: boolean;
  testID?: string;
}

/** One component type for the app's lifetime: a new type per render would remount the view and its surface. */
const NativeSurfaceView: ComponentType<NativeSurfaceProps> | null =
  nativeModule === null
    ? null
    : requireNativeViewManager<NativeSurfaceProps>('ElvEngineMedia3', 'Media3SurfaceView');

/**
 * The video surface of a Media3 engine (player core spec 6.1): a `SurfaceView` (or opt-in `TextureView`) under a
 * black zap shutter (shown from every `load` until that video media's first frame), with a `SubtitleView` above it,
 * natively. The picture keeps its display aspect ratio (`resizeMode`), and the screen stays on while the engine plays.
 * The engine sends `surface` `created` and `destroyed` events as the view's surface comes and goes. Renders nothing
 * where the native module is absent, or for an engine this module did not create or that was released.
 */
export function Media3Surface({
  engine,
  style,
  resizeMode,
  subtitleBottomInsetPx,
  subtitleFontFamily,
  subtitleStyle,
  surfaceRecreationToken,
  useTextureView,
  testID,
}: Media3SurfaceProps): ReactElement | null {
  const native = handles.get(engine);
  if (NativeSurfaceView === null || native === undefined) return null;
  return createElement(NativeSurfaceView, {
    engine: native,
    ...(style !== undefined ? { style } : {}),
    ...(resizeMode !== undefined ? { resizeMode } : {}),
    ...(subtitleBottomInsetPx !== undefined ? { subtitleBottomInsetPx } : {}),
    ...(subtitleFontFamily !== undefined ? { subtitleFontFamily } : {}),
    ...(subtitleStyle !== undefined ? { subtitleStyle } : {}),
    ...(surfaceRecreationToken !== undefined ? { surfaceRecreationToken } : {}),
    ...(useTextureView !== undefined ? { useTextureView } : {}),
    ...(testID !== undefined ? { testID } : {}),
  });
}

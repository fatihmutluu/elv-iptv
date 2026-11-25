import {
  bridgeNativeEngine,
  type DisplaySyncPolicy,
  type EngineCapabilities,
  type EngineEvent,
  type ExternalSubtitleTrack,
  type LoadOptions,
  type NativeEngineHandle,
  type NativeLoadCommand,
  type PlayerEngine,
} from '@elv/playback';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { type ComponentType, createElement, type ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  extractMedia3NetworkLoadOptions,
  type Media3NetworkLoadOptions,
  normalizeMedia3DnsFamily,
  normalizeMedia3HostOverride,
} from './network-options';
import {
  extractMedia3WaveF7ALoadOptions,
  type Media3AutoFrameRateMode,
  type Media3DisplaySyncOptions,
  type Media3DrmCapabilities,
  type Media3DrmClearKeyPair,
  type Media3DrmConfig,
  type Media3DrmScheme,
  type Media3NightModeDrcPreset,
  type Media3WaveF7ALoadOptions,
  type Media3WidevineSecurityLevel,
  normalizeMedia3AudioDelayByRefreshRate,
  normalizeMedia3DisplaySyncPolicy,
  normalizeMedia3DrmCapabilities,
  normalizeMedia3NightModeDrc,
} from './wave-f7a-options';

export type {
  Media3AutoFrameRateMode,
  Media3DisplaySyncOptions,
  Media3DrmCapabilities,
  Media3DrmClearKeyPair,
  Media3DrmConfig,
  Media3DrmScheme,
  Media3NightModeDrcPreset,
  Media3WidevineSecurityLevel,
};

/** Extended Media3 `PlayerEngine` exposing Android per-refresh-rate A/V delay updates (`#115`). */
export interface Media3PlayerEngine extends PlayerEngine {
  setAudioDelayByRefreshRate?(offsets: Readonly<Record<string, number>>): void;
}

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

/** Normalized Android thermal pressure state from `PowerManager` (`#232`). */
export type AndroidThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

/** Snapshot of Android device memory capabilities from `ActivityManager` (`#232`). */
export interface AndroidDeviceMemoryInfo {
  readonly isLowRamDevice: boolean;
  readonly totalMemBytes: number;
  readonly lowRam: boolean;
}

/** Optional video bounds in screen pixels forwarded to Android PiP `sourceRectHint` (`#34`). */
export interface AndroidPipSourceRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Optional Multi-View configuration passed when creating or updating a Media3 engine (`#34`, `#221`). */
export interface Media3EngineOptions {
  readonly handleAudioFocus?: boolean;
  readonly multiViewTileCount?: number;
}

interface RawPickedPlaylistFile {
  name?: unknown;
  bytes?: unknown;
  base64?: unknown;
}

const ZERO_INSETS: AndroidSafeAreaInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const DEFAULT_MEMORY_INFO: AndroidDeviceMemoryInfo = Object.freeze({
  isLowRamDevice: false,
  totalMemBytes: 0,
  lowRam: false,
});

interface RawInsets {
  top?: unknown;
  right?: unknown;
  bottom?: unknown;
  left?: unknown;
}

interface RawMemoryInfo {
  isLowRamDevice?: unknown;
  totalMemBytes?: unknown;
  lowRam?: unknown;
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
  configureMultiView?(handleAudioFocus: boolean, tileCount: number): void;
  setAudioDelayByRefreshRate?(offsets: Readonly<Record<string, number>>): void;
  addListener: {
    (eventName: 'onEngineEvent', listener: (event: EngineEvent) => void): { remove(): void };
    (eventName: 'onRemoteMediaAction', listener: (payload: unknown) => void): { remove(): void };
  };
}

interface NativeEngineModule {
  Engine: new (options?: {
    handleAudioFocus: boolean;
    multiViewTileCount: number;
  }) => Media3NativeEngineHandle;
  uptimeMs(): number;
  getThermalState?(): unknown;
  getDeviceMemoryInfo?(): RawMemoryInfo | null | undefined;
  getDrmCapabilities?(): unknown;
  setOrientationLocked?(locked: boolean): void;
  requestTemporaryOrientation?(landscape: boolean): void;
  applyShortEdgesCutoutMode?(): void;
  getSafeAreaInsets?(): RawInsets | null | undefined;
  enterPictureInPicture?(
    aspectWidth?: number,
    aspectHeight?: number,
    sourceLeft?: number,
    sourceTop?: number,
    sourceRight?: number,
    sourceBottom?: number,
  ): boolean;
  setAutoEnterPictureInPicture?(
    enabled: boolean,
    aspectWidth?: number,
    aspectHeight?: number,
    sourceLeft?: number,
    sourceTop?: number,
    sourceRight?: number,
    sourceBottom?: number,
  ): boolean;
  readClipboardText?(): Promise<string | null | undefined>;
  pickPlaylistFile?(): Promise<RawPickedPlaylistFile | null | undefined>;
  addListener?(
    eventName:
      | 'onStandbyChanged'
      | 'onSafeAreaInsetsChanged'
      | 'onPictureInPictureChanged'
      | 'onThermalStateChanged',
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

function parseThermalState(payload: unknown): AndroidThermalState | null {
  const candidate =
    typeof payload === 'string'
      ? payload
      : typeof payload === 'object' && payload !== null && 'state' in payload
        ? (payload as Record<string, unknown>).state
        : null;
  return candidate === 'nominal' ||
    candidate === 'fair' ||
    candidate === 'serious' ||
    candidate === 'critical'
    ? candidate
    : null;
}

function normalizeDeviceMemoryInfo(raw: unknown): AndroidDeviceMemoryInfo {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_MEMORY_INFO;
  const r = raw as RawMemoryInfo;
  return {
    isLowRamDevice: Boolean(r.isLowRamDevice),
    totalMemBytes: finiteNonNeg(r.totalMemBytes),
    lowRam: Boolean(r.lowRam),
  };
}

function normalizePipSourceRect(
  rect: AndroidPipSourceRect | undefined,
): AndroidPipSourceRect | null {
  if (rect === undefined) return null;
  const { left, top, right, bottom } = rect;
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null;
  }
  if (left < 0 || top < 0 || right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function clampMultiViewTileCount(tileCount: number | undefined): number {
  if (typeof tileCount !== 'number' || !Number.isFinite(tileCount)) return 1;
  const rounded = Math.trunc(tileCount);
  if (rounded < 1) return 1;
  if (rounded > 4) return 4;
  return rounded;
}

function normalizeEngineOptions(options: Media3EngineOptions): {
  handleAudioFocus: boolean;
  multiViewTileCount: number;
} {
  return {
    handleAudioFocus: options.handleAudioFocus ?? true,
    multiViewTileCount: clampMultiViewTileCount(options.multiViewTileCount),
  };
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

function wrap(module: NativeEngineModule, options?: Media3EngineOptions): Media3PlayerEngine {
  const native =
    options === undefined
      ? new module.Engine()
      : new module.Engine(normalizeEngineOptions(options));
  let pendingNetwork: Media3NetworkLoadOptions = {};
  let pendingWaveF7A: Media3WaveF7ALoadOptions = {};
  const nativeBridgeTarget = new Proxy(native, {
    get(target, prop) {
      if (prop === 'load') {
        return (command: NativeLoadCommand): void => {
          const {
            dnsFamily: rawDns,
            hostOverride: rawHost,
            drm: _rawDrm,
            displaySync: _rawDisplaySync,
            nightModeDrc: _rawDrc,
            ...rest
          } = { ...command, ...pendingNetwork } as NativeLoadCommand & {
            dnsFamily?: unknown;
            hostOverride?: unknown;
          };
          const f7a = pendingWaveF7A;
          pendingNetwork = {};
          pendingWaveF7A = {};
          const dnsFamily = normalizeMedia3DnsFamily(rawDns);
          const hostOverride = normalizeMedia3HostOverride(rawHost);
          target.load({
            ...rest,
            ...(dnsFamily === undefined ? {} : { dnsFamily }),
            ...(hostOverride === undefined ? {} : { hostOverride }),
            ...f7a,
          } as NativeLoadCommand);
        };
      }
      if (prop === 'setNightModeDrc' && typeof target.setNightModeDrc === 'function') {
        return (preset: Media3NightModeDrcPreset): void => {
          target.setNightModeDrc?.(normalizeMedia3NightModeDrc(preset) ?? 'off');
        };
      }
      if (prop === 'setDisplaySync' && typeof target.setDisplaySync === 'function') {
        return (policy: DisplaySyncPolicy): void => {
          target.setDisplaySync?.(normalizeMedia3DisplaySyncPolicy(policy));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const bridged = bridgeNativeEngine(nativeBridgeTarget, {
    capabilities: CAPABILITIES,
    uptimeMs: () => module.uptimeMs(),
    now: () => performance.now(),
  });
  let released = false;
  const engine: Media3PlayerEngine = {
    ...bridged,
    load(cmd) {
      pendingNetwork = extractMedia3NetworkLoadOptions(cmd);
      pendingWaveF7A = extractMedia3WaveF7ALoadOptions(cmd);
      try {
        bridged.load(cmd);
      } finally {
        pendingNetwork = {};
        pendingWaveF7A = {};
      }
    },
    ...(native.setPitchLock === undefined
      ? {}
      : {
          setPitchLock(_attempt, locked) {
            if (!released) native.setPitchLock?.(Boolean(locked));
          },
        }),
    ...(native.setAudioDelayByRefreshRate === undefined
      ? {}
      : {
          setAudioDelayByRefreshRate(offsets) {
            if (!released) {
              native.setAudioDelayByRefreshRate?.(
                normalizeMedia3AudioDelayByRefreshRate(offsets) ?? {},
              );
            }
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
 * when the player screen goes away. Pass `options` for Multi-View secondary tiles (`handleAudioFocus: false`,
 * `multiViewTileCount: 2..4`).
 */
export function createMedia3Engine(options?: Media3EngineOptions): Media3PlayerEngine | null {
  return nativeModule === null ? null : wrap(nativeModule, options);
}

/** Updates Multi-View audio focus ownership and tile-count buffer scaling on a live Media3 engine (`#34`, `#221`). */
export function configureMedia3MultiView(engine: PlayerEngine, options: Media3EngineOptions): void {
  const normalized = normalizeEngineOptions(options);
  handles
    .get(engine)
    ?.configureMultiView?.(normalized.handleAudioFocus, normalized.multiViewTileCount);
}

/** Sets Android API 28+ Night-Mode DRC preset (`'off' | 'light' | 'night'`) on a live Media3 engine (`#115`). */
export function setMedia3NightModeDrc(
  engine: PlayerEngine,
  preset: Media3NightModeDrcPreset,
): void {
  handles.get(engine)?.setNightModeDrc?.(normalizeMedia3NightModeDrc(preset) ?? 'off');
}

/** Configures Android Auto Frame-Rate display sync (`'off' | 'seamless' | 'always'`) on a live Media3 engine (`#116`). */
export function setMedia3DisplaySync(
  engine: PlayerEngine,
  options: Media3DisplaySyncOptions,
): void {
  handles.get(engine)?.setDisplaySync?.(normalizeMedia3DisplaySyncPolicy(options));
}

/** Configures per-refresh-rate A/V delay offsets (`[-1000, 1000]` ms) on a live Media3 engine (`#115`). */
export function setMedia3AudioDelayByRefreshRate(
  engine: PlayerEngine,
  offsets: Readonly<Record<string, number>>,
): void {
  handles
    .get(engine)
    ?.setAudioDelayByRefreshRate?.(normalizeMedia3AudioDelayByRefreshRate(offsets) ?? {});
}

/** Probes Android Widevine L1/L3 and ClearKey DRM capabilities safely (`#272`). */
export function getDrmCapabilities(): Media3DrmCapabilities {
  return normalizeMedia3DrmCapabilities(nativeModule?.getDrmCapabilities?.());
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

/** Requests Android Picture-in-Picture with aspect ratio clamped to Android's safe bounds (`#266`, `#34`). */
export function enterAndroidPictureInPicture(
  aspectWidth?: number,
  aspectHeight?: number,
  sourceRect?: AndroidPipSourceRect,
): boolean {
  const validRect = normalizePipSourceRect(sourceRect);
  if (validRect !== null) {
    return Boolean(
      nativeModule?.enterPictureInPicture?.(
        aspectWidth,
        aspectHeight,
        validRect.left,
        validRect.top,
        validRect.right,
        validRect.bottom,
      ),
    );
  }
  return Boolean(nativeModule?.enterPictureInPicture?.(aspectWidth, aspectHeight));
}

/**
 * Configures Android 12+ (API 31+) automatic PiP entry (`setAutoEnterEnabled`) with clamped aspect ratio and
 * optional `sourceRectHint` on non-TV devices (`#34`). Returns `false` when unsupported or absent.
 */
export function setAndroidAutoEnterPictureInPicture(
  enabled: boolean,
  aspectWidth?: number,
  aspectHeight?: number,
  sourceRect?: AndroidPipSourceRect,
): boolean {
  const validRect = normalizePipSourceRect(sourceRect);
  if (validRect !== null) {
    return Boolean(
      nativeModule?.setAutoEnterPictureInPicture?.(
        Boolean(enabled),
        aspectWidth,
        aspectHeight,
        validRect.left,
        validRect.top,
        validRect.right,
        validRect.bottom,
      ),
    );
  }
  return Boolean(
    nativeModule?.setAutoEnterPictureInPicture?.(Boolean(enabled), aspectWidth, aspectHeight),
  );
}

/** Reads the current normalized Android thermal pressure level (`#232`), defaulting to `'nominal'` when absent. */
export function getAndroidThermalState(): AndroidThermalState {
  return parseThermalState(nativeModule?.getThermalState?.()) ?? 'nominal';
}

/** Subscribes to live Android `PowerManager` thermal state transitions (`#232`). */
export function subscribeAndroidThermalState(
  listener: (state: AndroidThermalState) => void,
): () => void {
  const sub = nativeModule?.addListener?.('onThermalStateChanged', (payload) => {
    const parsed = parseThermalState(payload);
    if (parsed !== null) listener(parsed);
  });
  return () => {
    sub?.remove();
  };
}

/** Reads Android `ActivityManager` RAM tier metadata for Multi-View admission gating (`#232`). */
export function getAndroidDeviceMemoryInfo(): AndroidDeviceMemoryInfo {
  return normalizeDeviceMemoryInfo(nativeModule?.getDeviceMemoryInfo?.());
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

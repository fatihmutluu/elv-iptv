import {
  bridgeNativeEngine,
  type EngineCapabilities,
  type EngineEvent,
  type NativeEngineHandle,
  type PlayerEngine,
} from '@elv/playback';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { type ComponentType, createElement, type ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** The JS clock of React Native and Node; declared here because the package compiles without DOM types. */
declare const performance: { now(): number };

/** Safe-area edge insets reported by iOS `UIWindow` / `AetherSurfaceView` in points (`#415`). */
export interface AppleSafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A local playlist file picked through iOS `UIDocumentPickerViewController` (`#51`). */
export interface ApplePickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface RawPickedPlaylistFile {
  name?: unknown;
  bytes?: unknown;
  base64?: unknown;
}

/** Typed playback metadata forwarded to Apple `MPNowPlayingInfoCenter` (`#413`). */
export interface AetherMediaMetadata {
  readonly title: string;
  readonly subtitle?: string;
  readonly artworkUrl?: string;
  readonly kind?: 'live' | 'vod';
  readonly canStepTrack?: boolean;
}

/** Remote media transport action emitted from Apple Control Center / Lock Screen / Siri Remote (`#413`). */
export type AetherRemoteMediaAction = 'next' | 'previous' | 'stop';

/** Hardware keyboard playback shortcut emitted by iOS/iPadOS `UIKeyCommand` (`#415`). */
export type AppleHardwareKey =
  | 'play-pause'
  | 'seek-back'
  | 'seek-forward'
  | 'channel-up'
  | 'channel-down'
  | 'volume-up'
  | 'volume-down'
  | 'mute'
  | 'aspect'
  | 'back';

const ZERO_INSETS: AppleSafeAreaInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

const VALID_HARDWARE_KEYS: ReadonlySet<string> = new Set<AppleHardwareKey>([
  'play-pause',
  'seek-back',
  'seek-forward',
  'channel-up',
  'channel-down',
  'volume-up',
  'volume-down',
  'mute',
  'aspect',
  'back',
]);

interface RawInsets {
  top?: unknown;
  right?: unknown;
  bottom?: unknown;
  left?: unknown;
}

interface AetherNativeEngineHandle extends NativeEngineHandle {
  setMuted?(muted: boolean): void;
  setVolume?(volume: number): void;
  setAudioDelay?(attempt: number, delayMs: number): void;
  setSubtitleDelay?(attempt: number, delayMs: number): void;
  selectVideoQuality?(attempt: number, id: string | null): void;
  setBackgroundAudioEnabled?(enabled: boolean): void;
  setAllowDetachedSurface?(enabled: boolean): void;
  setMediaMetadata?(metadata: AetherMediaMetadata | null): void;
  addListener: {
    (eventName: 'onEngineEvent', listener: (event: EngineEvent) => void): { remove(): void };
    (eventName: 'onRemoteMediaAction', listener: (payload: unknown) => void): { remove(): void };
  };
}

interface NativeEngineModule {
  Engine: new () => AetherNativeEngineHandle;
  uptimeMs(): number;
  engineVersion(): string;
  deviceModel?(): string;
  readPersistentValue?(key: string): string | null | undefined;
  writePersistentValue?(key: string, value: string): boolean;
  writeLocalPersistentValue?(key: string, value: string): boolean;
  persistentStorageBudgetBytes?(): number;
  getSafeAreaInsets?(): RawInsets | null | undefined;
  readClipboardText?(): Promise<string | null | undefined>;
  pickPlaylistFile?(): Promise<RawPickedPlaylistFile | null | undefined>;
  addListener?(
    eventName: 'onSafeAreaInsetsChanged' | 'onHardwareKey',
    listener: (payload: unknown) => void,
  ): { remove(): void };
}

function finiteNonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeInsets(raw: unknown): AppleSafeAreaInsets {
  if (typeof raw !== 'object' || raw === null) return ZERO_INSETS;
  const r = raw as RawInsets;
  return {
    top: finiteNonNeg(r.top),
    right: finiteNonNeg(r.right),
    bottom: finiteNonNeg(r.bottom),
    left: finiteNonNeg(r.left),
  };
}

function parseHardwareKey(payload: unknown): AppleHardwareKey | null {
  const candidate =
    typeof payload === 'string'
      ? payload
      : typeof payload === 'object' && payload !== null && 'key' in payload
        ? (payload as Record<string, unknown>).key
        : null;
  return typeof candidate === 'string' && VALID_HARDWARE_KEYS.has(candidate)
    ? (candidate as AppleHardwareKey)
    : null;
}

function parseRemoteMediaAction(payload: unknown): AetherRemoteMediaAction | null {
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

function normalizePickedPlaylist(raw: unknown): ApplePickedPlaylistFile | null {
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

/** Hardware rendering tier derived from the Apple machine identifier (`#186`). */
export type AppleHardwareTier = 'standard' | 'mid-power';

const MID_POWER_APPLE_TV_PATTERN = /^AppleTV(?:5|6),/;

const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: true,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
  audioDelay: true,
  subtitleDelay: true,
  videoQualitySelection: true,
});

/** The native shared object behind each live engine this module created; `AetherSurface` binds its view to it. */
const handles = new WeakMap<PlayerEngine, AetherNativeEngineHandle>();

const nativeModule = requireOptionalNativeModule<NativeEngineModule>('ElvEngineAether');

/**
 * Returns the linked AetherEngine library version on Apple platforms (iOS, iPadOS, tvOS),
 * or `null` where the native module is absent (Android, web, headless tests).
 */
export function aetherEngineVersion(): string | null {
  return nativeModule === null ? null : nativeModule.engineVersion();
}

/**
 * Classifies constrained Apple TV hardware (`AppleTV5,*` 2 GB HD and `AppleTV6,*` 3 GB 4K 1st gen)
 * as `'mid-power'` so heavy blur/compositor effects can be bypassed (`#186`).
 */
export function resolveAppleHardwareTier(model: string | null | undefined): AppleHardwareTier {
  if (typeof model !== 'string') return 'standard';
  const trimmed = model.trim();
  if (trimmed.length === 0) return 'standard';
  return MID_POWER_APPLE_TV_PATTERN.test(trimmed) ? 'mid-power' : 'standard';
}

/**
 * Returns the Apple hardware machine identifier (e.g. `'AppleTV6,2'`, `'iPhone16,1'`) from the
 * native module, or `null` when unavailable or empty (`#186`).
 */
export function getAppleDeviceModel(): string | null {
  const raw = nativeModule?.deviceModel?.();
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads a purge-safe string value from Apple persistent KV storage (iCloud KVS when entitled,
 * falling back to `NSUserDefaults`), or `null` when absent or unavailable (`#79`).
 */
export function readApplePersistentValue(key: string): string | null {
  if (key.length === 0) return null;
  try {
    const raw = nativeModule?.readPersistentValue?.(key);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Writes a byte-budgeted string value to Apple persistent KV storage (iCloud KVS up to 900 KB
 * when entitled and `NSUserDefaults` mirror up to 384 KB), returning `true` when persisted (`#79`).
 */
export function writeApplePersistentValue(key: string, value: string): boolean {
  if (key.length === 0) return false;
  try {
    return Boolean(nativeModule?.writePersistentValue?.(key, value));
  } catch {
    return false;
  }
}

/**
 * Writes a strictly byte-clamped (`<= 384 KB`) string mirror directly to Apple `NSUserDefaults`
 * so local purge recovery stays fresh when an iCloud KVS payload exceeds `384 KB` (`#79`).
 */
export function writeAppleLocalPersistentValue(key: string, value: string): boolean {
  if (key.length === 0) return false;
  try {
    return Boolean(nativeModule?.writeLocalPersistentValue?.(key, value));
  } catch {
    return false;
  }
}

/**
 * Returns the active UTF-8 payload byte ceiling for Apple persistent KV storage (`921_600` with
 * iCloud KVS, `393_216` local-only), or `null` where the native bridge is unavailable (`#79`).
 */
export function getApplePersistentBudgetBytes(): number | null {
  try {
    const raw = nativeModule?.persistentStorageBudgetBytes?.();
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  } catch {
    return null;
  }
}

/** Reads current iOS safe-area edge insets in points (`0` on tvOS or when native module is absent, `#415`). */
export function getAppleSafeAreaInsets(): AppleSafeAreaInsets {
  return normalizeInsets(nativeModule?.getSafeAreaInsets?.());
}

/** Subscribes to live iOS safe-area inset updates across portrait and landscape rotations (`#415`). */
export function subscribeAppleSafeAreaInsets(
  listener: (insets: AppleSafeAreaInsets) => void,
): () => void {
  const sub = nativeModule?.addListener?.('onSafeAreaInsetsChanged', (payload) => {
    listener(normalizeInsets(payload));
  });
  return () => {
    sub?.remove();
  };
}

/** Subscribes to iOS/iPadOS `UIKeyCommand` hardware keyboard playback actions (`#415`). */
export function subscribeAppleHardwareKeys(listener: (key: AppleHardwareKey) => void): () => void {
  const sub = nativeModule?.addListener?.('onHardwareKey', (payload) => {
    const key = parseHardwareKey(payload);
    if (key !== null) listener(key);
  });
  return () => {
    sub?.remove();
  };
}

/** Sets native `AVPlayer.isMuted` on a live engine created by {@link createAetherEngine} (`#415`). */
export function setAppleEngineMuted(engine: PlayerEngine, muted: boolean): void {
  handles.get(engine)?.setMuted?.(Boolean(muted));
}

/** Sets native `AVPlayer.volume` (`0`–`100`, clamped) on a live engine created by {@link createAetherEngine} (`#415`). */
export function setAppleEngineVolume(engine: PlayerEngine, volume: number): void {
  if (!Number.isFinite(volume)) return;
  const clamped = Math.min(100, Math.max(0, volume));
  handles.get(engine)?.setVolume?.(clamped);
}

/** Enables or disables opt-in background audio playback on a live AetherEngine (`#413`). */
export function setAetherBackgroundAudioEnabled(engine: PlayerEngine, enabled: boolean): void {
  handles.get(engine)?.setBackgroundAudioEnabled?.(Boolean(enabled));
}

/**
 * Allows or disallows non-terminal local video surface detachment (e.g. PiP or AirPlay handoff)
 * on a live AetherEngine (`#117`).
 */
export function setAetherDetachedSurfaceAllowed(engine: PlayerEngine, enabled: boolean): void {
  handles.get(engine)?.setAllowDetachedSurface?.(Boolean(enabled));
}

/** Publishes or clears Apple `MPNowPlayingInfoCenter` metadata on a live AetherEngine (`#413`). */
export function setAetherMediaMetadata(
  engine: PlayerEngine,
  metadata: AetherMediaMetadata | null,
): void {
  handles.get(engine)?.setMediaMetadata?.(metadata);
}

/** Subscribes to Apple `MPRemoteCommandCenter` remote next/previous/stop actions on a live AetherEngine (`#413`). */
export function subscribeAetherRemoteMediaAction(
  engine: PlayerEngine,
  listener: (action: AetherRemoteMediaAction) => void,
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

/**
 * Reads plain text from iOS `UIPasteboard.general.string`, returning `null` on tvOS or when empty/unavailable (`#51`).
 */
export async function readAppleClipboardText(): Promise<string | null> {
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
 * Opens iOS `UIDocumentPickerViewController` to copy a local playlist file (bounded to 64 MiB).
 * Safely returns `null` on tvOS, when cancelled, or when the native module is absent (`#51`).
 */
export async function pickApplePlaylistFile(): Promise<ApplePickedPlaylistFile | null> {
  const pick = nativeModule?.pickPlaylistFile;
  if (typeof pick !== 'function') return null;
  const raw = await pick();
  return normalizePickedPlaylist(raw);
}

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

/**
 * Creates an AetherEngine player engine (tvOS, iOS, iPadOS) implementing the `PlayerEngine` port,
 * or returns `null` where the native module is absent. Call `release()` when the player screen unmounts.
 */
export function createAetherEngine(): PlayerEngine | null {
  return nativeModule === null ? null : wrap(nativeModule);
}

/** Props of {@link AetherSurface}. */
export interface AetherSurfaceProps {
  /** An engine from {@link createAetherEngine}; one surface per engine. */
  engine: PlayerEngine;
  /** Layout only: nothing is painted over the video, so overlays compose above it. */
  style?: StyleProp<ViewStyle>;
  /**
   * How the picture meets the view: `fit` (default) shows all of it with black bars beside it,
   * `fill` covers the view and crops the overflow, `stretch` fills the view ignoring aspect ratio.
   */
  resizeMode?: 'fit' | 'fill' | 'stretch';
  /** Extra bottom inset in pt to lift native subtitle cues above a visible OSD (`#136`). */
  subtitleBottomInsetPx?: number;
  /** High-legibility subtitle font override (`'system'`, `'atkinson'`, or `'opendyslexic'`, `#163`). */
  subtitleFontFamily?: 'system' | 'atkinson' | 'opendyslexic';
  /** Whether the player OSD is currently visible so native can throttle hidden-OSD clock ticks (`#442`). */
  osdVisible?: boolean;
  testID?: string;
}

interface NativeSurfaceProps {
  engine: NativeEngineHandle;
  style?: StyleProp<ViewStyle>;
  resizeMode?: 'fit' | 'fill' | 'stretch';
  subtitleBottomInsetPx?: number;
  subtitleFontFamily?: 'system' | 'atkinson' | 'opendyslexic';
  osdVisible?: boolean;
  testID?: string;
}

/** One component type for the app's lifetime so renders never remount the native surface view. */
const NativeSurfaceView: ComponentType<NativeSurfaceProps> | null =
  nativeModule === null
    ? null
    : requireNativeViewManager<NativeSurfaceProps>('ElvEngineAether', 'AetherSurfaceView');

/**
 * The video surface of an AetherEngine instance (player core spec 6.2): an `AetherPlayerView` under
 * a native black zap shutter shown from each `load` until that media's first frame, keeping the screen
 * awake while playing and reporting `surface` `created`/`destroyed` across window and background changes.
 * Renders nothing without the native module, or for a foreign or released engine.
 */
export function AetherSurface({
  engine,
  style,
  resizeMode,
  subtitleBottomInsetPx,
  subtitleFontFamily,
  osdVisible,
  testID,
}: AetherSurfaceProps): ReactElement | null {
  const native = handles.get(engine);
  if (NativeSurfaceView === null || native === undefined) return null;
  return createElement(NativeSurfaceView, {
    engine: native,
    style,
    resizeMode,
    subtitleBottomInsetPx,
    ...(subtitleFontFamily !== undefined ? { subtitleFontFamily } : {}),
    ...(osdVisible !== undefined ? { osdVisible } : {}),
    testID,
  });
}

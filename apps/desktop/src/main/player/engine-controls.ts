import { normalizeSubtitleStyle, type SubtitleStyleConfig } from '@elv/domain';
import {
  type AttemptToken,
  clampPlaybackSpeed,
  type DesktopAudioOutputConfig,
  type DisplaySyncPolicy,
} from '@elv/playback';
import type {
  AccessibilityFontFamily,
  DeinterlaceMode,
  HwdecProfile,
  ResizeMode,
} from '../../shared/player-ipc.ts';
import {
  desktopAudioOutputCommands,
  isAc3EncodeActive,
  isLoudnormSuppressedByOutput,
  isPassthroughAudioFailureLog,
  normalizeDesktopAudioOutputConfig,
  passthroughFallbackCommands,
  sameDesktopAudioOutputConfig,
} from './mpv/audio-output.ts';
import { type AudioRampTimers, createAudioRamp } from './mpv/audio-ramp.ts';
import type { MpvCommand } from './mpv/codec.ts';
import type { LiveSession, MediaSlot } from './mpv/live-session.ts';
import {
  audioNormalizationCommand,
  DEINTERLACE_BWDIF_FILTER,
  deinterlaceCommands,
  isSpdifPassthroughValue,
  LOUDNORM_FILTER,
  pitchLockCommand,
  videoSyncCommand,
  videoSyncModeFor,
} from './mpv/options.ts';
import { subtitlePositionCommands, subtitleStyleCommands } from './mpv/subtitle-style.ts';

export { DEINTERLACE_BWDIF_FILTER, isSpdifPassthroughValue, LOUDNORM_FILTER };

/** Maps an {@link AccessibilityFontFamily} preference to mpv's `sub-font` property value (`'sans-serif'` restores mpv's documented default). */
export function mapSubtitleFontFamily(family: AccessibilityFontFamily): string {
  switch (family) {
    case 'atkinson':
      return 'Atkinson Hyperlegible Next';
    case 'opendyslexic':
      return 'OpenDyslexic';
    case 'system':
      return 'sans-serif';
  }
}

/** Hooks connecting {@link createEngineControls} to `createMpvEngine`. */
export interface EngineControlsDeps {
  isReleased(): boolean;
  getLive(): LiveSession | undefined;
  getMedia(): MediaSlot | undefined;
  adopt(token: AttemptToken): void;
  enqueueCommand(cmd: MpvCommand, slot?: MediaSlot): void;
  now(): number;
  timers: AudioRampTimers;
  platform?: string;
  audioRampMs?: number;
  initialDarwinCompat?: boolean;
  initialSpdifPassthrough?: boolean;
  isSecondarySubtitleActive?(): boolean;
  onPassthroughFallback?(): void;
}

/** Speed/seek coalescing, audio ramp play/pause, and runtime property-setter helpers for `MpvEngine`. */
export interface EngineControls {
  reset(): void;
  onSeekQueued(): void;
  onCommandSettled(command: MpvCommand): void;
  onAudioProperty(name: 'volume' | 'mute', value: unknown): void;
  onAudioSpdifProperty(value: unknown): void;
  onMpvLog(entry: { readonly prefix: string; readonly level: string; readonly text: string }): void;
  isSpdifPassthroughActive(): boolean;
  isAudioNormalizationSuppressed(): boolean;
  cancelRamp(restoreVolume: boolean, direct?: boolean): void;
  play(attempt: AttemptToken): void;
  pause(attempt: AttemptToken): void;
  toggleMute(): void;
  setMuted(muted: boolean): void;
  setSpeed(attempt: AttemptToken, rate: number): void;
  setVolume(volume: number): void;
  setAudioDelay(attempt: AttemptToken, delayMs: number): void;
  setAudioDelay(delaySec: number): void;
  setSubtitleDelay(attempt: AttemptToken, delayMs: number): void;
  setSubtitleDelay(delaySec: number): void;
  setAudioDevice(device: string): void;
  getDesiredAudioDevice(): string | undefined;
  setDeinterlace(enabled: boolean): void;
  setDeinterlaceMode(mode: DeinterlaceMode): void;
  getDesiredDeinterlaceMode(): DeinterlaceMode | undefined;
  setPitchLock(lockedOrAttempt: boolean | AttemptToken, maybeLocked?: boolean): void;
  getDesiredPitchLock(): boolean | undefined;
  setAudioNormalization(enabled: boolean): void;
  getDesiredAudioNormalization(): boolean | undefined;
  setDisplaySync(policy: DisplaySyncPolicy): void;
  rememberDisplaySync(policy: DisplaySyncPolicy): void;
  getDesiredDisplaySync(): DisplaySyncPolicy | undefined;
  setDesktopAudioOutput(config: DesktopAudioOutputConfig): void;
  rememberDesktopAudioOutput(config: DesktopAudioOutputConfig): void;
  getDesiredDesktopAudioOutput(): DesktopAudioOutputConfig | undefined;
  setHwdec(profile: HwdecProfile): void;
  setResizeMode(mode: ResizeMode): void;
  setFilterSdh(enabled: boolean): void;
  setSubtitleFontFamily(family: AccessibilityFontFamily): void;
  getDesiredSubtitleFont(): string | undefined;
  setSubtitleStyle(style: SubtitleStyleConfig): void;
  syncSubtitlePosition(secondaryActive: boolean): void;
  rememberSubtitleStyle(style: SubtitleStyleConfig): SubtitleStyleConfig;
  getDesiredSubtitleStyle(): SubtitleStyleConfig | undefined;
}

/** Creates speed coalescing, audio ramp, and runtime property-setter controllers for `createMpvEngine`. */
export function createEngineControls(deps: EngineControlsDeps): EngineControls {
  let pendingSeeks = 0;
  let speedInFlight = false;
  let pendingSpeed: { slot: MediaSlot | undefined; rate: number } | undefined;
  let darwinCompatActive = deps.initialDarwinCompat === true;
  let spdifPassthroughActive = deps.initialSpdifPassthrough === true;
  let desiredAudioDevice: string | undefined;
  let desiredSubtitleFont: string | undefined;
  let desiredSubtitleStyle: SubtitleStyleConfig | undefined;
  let desiredDeinterlaceMode: DeinterlaceMode | undefined;
  let desiredPitchLock: boolean | undefined;
  let desiredAudioNormalization: boolean | undefined;
  let desiredDisplaySync: DisplaySyncPolicy | undefined;
  let requestedDesktopAudioOutput: DesktopAudioOutputConfig | undefined;
  let effectiveDesktopAudioOutput: DesktopAudioOutputConfig | undefined;
  let passthroughFallbackActive = false;

  const isNormSuppressed = (): boolean =>
    isLoudnormSuppressedByOutput(spdifPassthroughActive, effectiveDesktopAudioOutput);

  const syncNormalization = (): void => {
    const live = deps.getLive();
    if (deps.isReleased() || live === undefined || desiredAudioNormalization !== true) return;
    const suppressed = isNormSuppressed();
    if (suppressed && live.appliedAudioNormalization !== false) {
      live.appliedAudioNormalization = false;
      deps.enqueueCommand(audioNormalizationCommand(false));
    } else if (!suppressed && live.appliedAudioNormalization !== true) {
      live.appliedAudioNormalization = true;
      deps.enqueueCommand(audioNormalizationCommand(true));
    }
  };

  const restoreVolumeDirect = (volume: number): void => {
    const live = deps.getLive();
    if (live)
      void live.proc.client.command(['set_property', 'volume', volume]).catch(() => undefined);
  };

  const audioRamp = createAudioRamp({
    timers: deps.timers,
    now: deps.now,
    setVolume: (volume) => {
      if (!deps.isReleased()) deps.enqueueCommand(['set_property', 'volume', volume]);
    },
    ...(deps.audioRampMs === undefined ? {} : { durationMs: deps.audioRampMs }),
  });

  const flushPendingSpeed = (): void => {
    if (
      deps.isReleased() ||
      deps.getLive() === undefined ||
      pendingSeeks > 0 ||
      speedInFlight ||
      !pendingSpeed
    ) {
      return;
    }
    const next = pendingSpeed;
    pendingSpeed = undefined;
    if (next.slot !== deps.getMedia()) return;
    speedInFlight = true;
    deps.enqueueCommand(['set_property', 'speed', next.rate], next.slot);
  };

  const setProp = (name: string, value: string | number): void => {
    if (!deps.isReleased()) deps.enqueueCommand(['set_property', name, value]);
  };

  return {
    reset() {
      pendingSeeks = 0;
      speedInFlight = false;
      pendingSpeed = undefined;
    },
    onSeekQueued() {
      audioRamp.cancel(true);
      pendingSeeks += 1;
    },
    onCommandSettled(command) {
      const isSeek = command[0] === 'seek';
      const isSpeed = command[0] === 'set_property' && command[1] === 'speed';
      if (isSeek) pendingSeeks = Math.max(0, pendingSeeks - 1);
      if (isSpeed) speedInFlight = false;
      if (isSeek || isSpeed) flushPendingSpeed();
    },
    onAudioProperty(name, value) {
      audioRamp.onProperty(name, value);
    },
    onAudioSpdifProperty(value) {
      if (value === undefined) return;
      const next = isSpdifPassthroughValue(value);
      if (next === spdifPassthroughActive) return;
      spdifPassthroughActive = next;
      syncNormalization();
    },
    onMpvLog(entry) {
      if (deps.isReleased() || passthroughFallbackActive) return;
      const passthroughOrExclusiveActive =
        spdifPassthroughActive ||
        isAc3EncodeActive(effectiveDesktopAudioOutput) ||
        (effectiveDesktopAudioOutput !== undefined &&
          (effectiveDesktopAudioOutput.passthrough || effectiveDesktopAudioOutput.exclusive));
      if (!passthroughOrExclusiveActive) return;
      if (!isPassthroughAudioFailureLog(entry)) return;
      passthroughFallbackActive = true;
      spdifPassthroughActive = false;
      if (effectiveDesktopAudioOutput !== undefined) {
        effectiveDesktopAudioOutput = {
          ...effectiveDesktopAudioOutput,
          passthrough: false,
          exclusive: false,
          ac3Encode: false,
        };
      }
      const live = deps.getLive();
      if (live !== undefined) {
        live.appliedDesktopAudioOutput = effectiveDesktopAudioOutput;
        for (const cmd of passthroughFallbackCommands()) deps.enqueueCommand(cmd);
        syncNormalization();
      }
      deps.onPassthroughFallback?.();
    },
    isSpdifPassthroughActive() {
      return spdifPassthroughActive;
    },
    isAudioNormalizationSuppressed() {
      return isNormSuppressed();
    },
    cancelRamp(restoreVolume, direct = false) {
      audioRamp.cancel(restoreVolume, direct ? restoreVolumeDirect : undefined);
    },
    play(attempt) {
      if (deps.isReleased()) return;
      deps.adopt(attempt);
      const slot = deps.getMedia();
      const live = deps.getLive();
      if (!live || (!live.paused && !audioRamp.isRamping)) {
        deps.enqueueCommand(['set', 'pause', 'no'], slot);
        return;
      }
      audioRamp.rampPlay(() => {
        if (!deps.isReleased() && slot === deps.getMedia()) {
          deps.enqueueCommand(['set', 'pause', 'no'], slot);
        }
      });
    },
    pause(attempt) {
      if (deps.isReleased()) return;
      deps.adopt(attempt);
      const slot = deps.getMedia();
      const live = deps.getLive();
      if (!live || (live.paused && !audioRamp.isRamping)) {
        deps.enqueueCommand(['set', 'pause', 'yes'], slot);
        return;
      }
      audioRamp.rampPause(() => {
        if (!deps.isReleased() && slot === deps.getMedia()) {
          deps.enqueueCommand(['set', 'pause', 'yes'], slot);
        }
      });
    },
    toggleMute() {
      if (deps.isReleased()) return;
      audioRamp.cancel(true);
      deps.enqueueCommand(['cycle', 'mute']);
    },
    setMuted(muted) {
      if (deps.isReleased()) return;
      audioRamp.cancel(true);
      setProp('mute', muted ? 'yes' : 'no');
    },
    setSpeed(attempt, rate) {
      const media = deps.getMedia();
      if (deps.isReleased() || !media) return;
      const clamped = clampPlaybackSpeed(rate);
      if (clamped === undefined) return;
      deps.adopt(attempt);
      if (pendingSeeks > 0 || speedInFlight) {
        pendingSpeed = { slot: media, rate: clamped };
        return;
      }
      speedInFlight = true;
      deps.enqueueCommand(['set_property', 'speed', clamped], media);
    },
    setVolume(volume) {
      if (deps.isReleased() || !Number.isFinite(volume)) return;
      audioRamp.onUserVolume(volume);
      setProp('volume', volume);
    },
    setAudioDelay(attemptOrDelaySec: AttemptToken | number, maybeDelayMs?: number) {
      if (deps.isReleased()) return;
      if (maybeDelayMs !== undefined) {
        if (!Number.isFinite(maybeDelayMs)) return;
        deps.adopt(attemptOrDelaySec);
        const clampedMs = Math.max(-30_000, Math.min(30_000, maybeDelayMs));
        setProp('audio-delay', clampedMs / 1000);
        return;
      }
      if (Number.isFinite(attemptOrDelaySec)) {
        setProp('audio-delay', Math.max(-30, Math.min(30, attemptOrDelaySec)));
      }
    },
    setSubtitleDelay(attemptOrDelaySec: AttemptToken | number, maybeDelayMs?: number) {
      if (deps.isReleased()) return;
      if (maybeDelayMs !== undefined) {
        if (!Number.isFinite(maybeDelayMs)) return;
        deps.adopt(attemptOrDelaySec);
        const clampedMs = Math.max(-30_000, Math.min(30_000, maybeDelayMs));
        setProp('sub-delay', clampedMs / 1000);
        return;
      }
      if (Number.isFinite(attemptOrDelaySec)) {
        setProp('sub-delay', Math.max(-30, Math.min(30, attemptOrDelaySec)));
      }
    },
    setAudioDevice(device) {
      if (deps.isReleased() || device.length === 0) return;
      desiredAudioDevice = device;
      if (deps.getLive() !== undefined) setProp('audio-device', device);
    },
    getDesiredAudioDevice() {
      return desiredAudioDevice;
    },
    setDeinterlace(enabled) {
      this.setDeinterlaceMode(enabled ? 'auto' : 'off');
    },
    setDeinterlaceMode(mode) {
      if (deps.isReleased()) return;
      desiredDeinterlaceMode = mode;
      if (deps.getLive() !== undefined) {
        for (const cmd of deinterlaceCommands(mode)) deps.enqueueCommand(cmd);
      }
    },
    getDesiredDeinterlaceMode() {
      return desiredDeinterlaceMode;
    },
    setPitchLock(lockedOrAttempt, maybeLocked) {
      if (deps.isReleased()) return;
      const locked = typeof lockedOrAttempt === 'boolean' ? lockedOrAttempt : Boolean(maybeLocked);
      if (typeof lockedOrAttempt === 'number') deps.adopt(lockedOrAttempt);
      desiredPitchLock = locked;
      if (deps.getLive() !== undefined) deps.enqueueCommand(pitchLockCommand(locked));
    },
    getDesiredPitchLock() {
      return desiredPitchLock;
    },
    setAudioNormalization(enabled) {
      if (deps.isReleased()) return;
      desiredAudioNormalization = enabled;
      const live = deps.getLive();
      if (live === undefined) return;
      if (enabled) {
        if (isNormSuppressed()) {
          if (live.appliedAudioNormalization === true) {
            live.appliedAudioNormalization = false;
            deps.enqueueCommand(audioNormalizationCommand(false));
          }
          return;
        }
        live.appliedAudioNormalization = true;
        deps.enqueueCommand(audioNormalizationCommand(true));
      } else {
        live.appliedAudioNormalization = false;
        deps.enqueueCommand(audioNormalizationCommand(false));
      }
    },
    getDesiredAudioNormalization() {
      return desiredAudioNormalization;
    },
    setDisplaySync(policy) {
      if (deps.isReleased()) return;
      desiredDisplaySync = policy;
      const live = deps.getLive();
      if (live !== undefined) {
        const mode = videoSyncModeFor(policy);
        live.appliedVideoSync = mode;
        deps.enqueueCommand(videoSyncCommand(policy));
      }
    },
    rememberDisplaySync(policy) {
      desiredDisplaySync = policy;
    },
    getDesiredDisplaySync() {
      return desiredDisplaySync;
    },
    setDesktopAudioOutput(rawConfig) {
      if (deps.isReleased()) return;
      const normalized = normalizeDesktopAudioOutputConfig(rawConfig);
      if (!sameDesktopAudioOutputConfig(normalized, requestedDesktopAudioOutput)) {
        requestedDesktopAudioOutput = normalized;
        effectiveDesktopAudioOutput = normalized;
        passthroughFallbackActive = false;
      } else if (passthroughFallbackActive) {
        return;
      }
      const effective = effectiveDesktopAudioOutput ?? normalized;
      spdifPassthroughActive = effective.passthrough && effective.codecs.length > 0;
      const live = deps.getLive();
      if (live === undefined) return;
      if (isNormSuppressed() && live.appliedAudioNormalization === true) {
        live.appliedAudioNormalization = false;
        deps.enqueueCommand(audioNormalizationCommand(false));
      }
      live.appliedDesktopAudioOutput = effective;
      for (const cmd of desktopAudioOutputCommands(effective)) {
        deps.enqueueCommand(cmd);
      }
      syncNormalization();
    },
    rememberDesktopAudioOutput(rawConfig) {
      const normalized = normalizeDesktopAudioOutputConfig(rawConfig);
      if (sameDesktopAudioOutputConfig(normalized, requestedDesktopAudioOutput)) return;
      requestedDesktopAudioOutput = normalized;
      effectiveDesktopAudioOutput = normalized;
      passthroughFallbackActive = false;
      spdifPassthroughActive = normalized.passthrough && normalized.codecs.length > 0;
    },
    getDesiredDesktopAudioOutput() {
      return effectiveDesktopAudioOutput;
    },
    setHwdec(profile) {
      if (deps.isReleased()) return;
      const hwdec = profile === 'darwin-compat' ? 'auto-safe' : profile;
      setProp('hwdec', hwdec);
      if (deps.platform === 'darwin') {
        if (profile === 'darwin-compat') {
          darwinCompatActive = true;
          setProp('hwdec-image-format', 'uyvy422');
        } else if (darwinCompatActive) {
          darwinCompatActive = false;
          setProp('hwdec-image-format', 'no');
        }
      }
    },
    setResizeMode(mode) {
      if (deps.isReleased()) return;
      if (mode === 'fit') {
        setProp('keepaspect', 'yes');
        setProp('panscan', 0);
        setProp('video-aspect-override', '-1');
      } else if (mode === 'fill') {
        setProp('keepaspect', 'yes');
        setProp('panscan', 1);
        setProp('video-aspect-override', '-1');
      } else {
        setProp('keepaspect', 'no');
        setProp('panscan', 0);
        setProp('video-aspect-override', '-1');
      }
    },
    setFilterSdh(enabled) {
      setProp('sub-filter-sdh', enabled ? 'yes' : 'no');
    },
    setSubtitleFontFamily(family) {
      if (deps.isReleased()) return;
      const mapped = mapSubtitleFontFamily(family);
      desiredSubtitleFont = mapped;
      if (deps.getLive() !== undefined) setProp('sub-font', mapped);
    },
    getDesiredSubtitleFont() {
      return desiredSubtitleFont;
    },
    setSubtitleStyle(style) {
      if (deps.isReleased()) return;
      const normalized = normalizeSubtitleStyle(style);
      desiredSubtitleStyle = normalized;
      if (deps.getLive() !== undefined) {
        const secondaryActive = deps.isSecondarySubtitleActive?.() === true;
        for (const cmd of subtitleStyleCommands(normalized, secondaryActive)) {
          deps.enqueueCommand(cmd);
        }
      }
    },
    syncSubtitlePosition(secondaryActive) {
      if (deps.isReleased() || deps.getLive() === undefined) return;
      if (desiredSubtitleStyle?.verticalPosition !== 'top') return;
      for (const cmd of subtitlePositionCommands(desiredSubtitleStyle, secondaryActive)) {
        deps.enqueueCommand(cmd);
      }
    },
    rememberSubtitleStyle(style) {
      const normalized = normalizeSubtitleStyle(style);
      desiredSubtitleStyle = normalized;
      return normalized;
    },
    getDesiredSubtitleStyle() {
      return desiredSubtitleStyle;
    },
  };
}

/** Updates per-session applied control markers after a queued mpv command finishes executing. */
export function trackAppliedControlCommand(
  target: LiveSession,
  command: MpvCommand,
  controls: EngineControls,
): void {
  if (
    command[0] === 'set_property' &&
    command[1] === 'audio-device' &&
    typeof command[2] === 'string'
  ) {
    target.appliedAudioDevice = command[2];
  } else if (
    command[0] === 'set_property' &&
    command[1] === 'sub-font' &&
    typeof command[2] === 'string'
  ) {
    target.appliedSubtitleFont = command[2];
  } else if (
    command[0] === 'set_property' &&
    command[1] === 'audio-pitch-correction' &&
    typeof command[2] === 'string'
  ) {
    target.appliedPitchLock = command[2] === 'yes';
  } else if (
    command[0] === 'set_property' &&
    command[1] === 'video-sync' &&
    (command[2] === 'audio' || command[2] === 'display-resample')
  ) {
    target.appliedVideoSync = command[2];
  } else if (
    command[0] === 'set_property' &&
    command[1] === 'deinterlace' &&
    command[2] === 'auto'
  ) {
    target.appliedDeinterlaceMode = 'auto';
  } else if (
    command[0] === 'vf' &&
    command[1] === 'add' &&
    typeof command[2] === 'string' &&
    command[2].startsWith('@elv_deint:')
  ) {
    target.appliedDeinterlaceMode = 'bwdif';
  } else if (
    command[0] === 'vf' &&
    command[1] === 'remove' &&
    command[2] === '@elv_deint' &&
    controls.getDesiredDeinterlaceMode() === 'off'
  ) {
    target.appliedDeinterlaceMode = 'off';
  } else if (
    command[0] === 'af' &&
    command[1] === 'add' &&
    typeof command[2] === 'string' &&
    command[2].startsWith('@elv_loudnorm:')
  ) {
    target.appliedAudioNormalization = true;
  } else if (command[0] === 'af' && command[1] === 'remove' && command[2] === '@elv_loudnorm') {
    target.appliedAudioNormalization = false;
  }
}

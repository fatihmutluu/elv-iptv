import { type AttemptToken, clampPlaybackSpeed } from '@elv/playback';
import type { HwdecProfile, ResizeMode } from '../../shared/player-ipc.ts';
import { type AudioRampTimers, createAudioRamp } from './mpv/audio-ramp.ts';
import type { MpvCommand } from './mpv/codec.ts';
import type { LiveSession, MediaSlot } from './mpv/live-session.ts';

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
}

/** Speed/seek coalescing, audio ramp play/pause, and runtime property-setter helpers for `MpvEngine`. */
export interface EngineControls {
  reset(): void;
  onSeekQueued(): void;
  onCommandSettled(command: MpvCommand): void;
  onAudioProperty(name: 'volume' | 'mute', value: unknown): void;
  cancelRamp(restoreVolume: boolean, direct?: boolean): void;
  play(attempt: AttemptToken): void;
  pause(attempt: AttemptToken): void;
  toggleMute(): void;
  setSpeed(attempt: AttemptToken, rate: number): void;
  setVolume(volume: number): void;
  setAudioDelay(delaySec: number): void;
  setSubtitleDelay(delaySec: number): void;
  setAudioDevice(device: string): void;
  getDesiredAudioDevice(): string | undefined;
  setDeinterlace(enabled: boolean): void;
  setHwdec(profile: HwdecProfile): void;
  setResizeMode(mode: ResizeMode): void;
  setFilterSdh(enabled: boolean): void;
}

/** Creates speed coalescing, audio ramp, and runtime property-setter controllers for `createMpvEngine`. */
export function createEngineControls(deps: EngineControlsDeps): EngineControls {
  let pendingSeeks = 0;
  let speedInFlight = false;
  let pendingSpeed: { slot: MediaSlot | undefined; rate: number } | undefined;
  let darwinCompatActive = deps.initialDarwinCompat === true;
  let desiredAudioDevice: string | undefined;

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
    setAudioDelay(delaySec) {
      if (Number.isFinite(delaySec)) setProp('audio-delay', delaySec);
    },
    setSubtitleDelay(delaySec) {
      if (Number.isFinite(delaySec)) setProp('sub-delay', delaySec);
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
      setProp('deinterlace', enabled ? 'yes' : 'no');
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
  };
}

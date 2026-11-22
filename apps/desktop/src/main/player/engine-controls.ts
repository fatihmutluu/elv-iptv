import { type AttemptToken, clampPlaybackSpeed } from '@elv/playback';
import type { MpvCommand } from './mpv/codec.ts';
import type { MediaSlot } from './mpv/live-session.ts';

/** Hooks connecting {@link createEngineControls} to `createMpvEngine`. */
export interface EngineControlsDeps {
  isReleased(): boolean;
  hasLive(): boolean;
  getMedia(): MediaSlot | undefined;
  adopt(token: AttemptToken): void;
  enqueueCommand(cmd: MpvCommand, slot?: MediaSlot): void;
}

/** Speed/seek coalescing and runtime mpv property-setter helpers for `MpvEngine`. */
export interface EngineControls {
  reset(): void;
  onSeekQueued(): void;
  onCommandSettled(command: MpvCommand): void;
  setSpeed(attempt: AttemptToken, rate: number): void;
  setVolume(volume: number): void;
  setAudioDelay(delaySec: number): void;
  setSubtitleDelay(delaySec: number): void;
  setAudioDevice(device: string): void;
  setDeinterlace(enabled: boolean): void;
}

/** Creates speed coalescing and runtime property-setter controllers for `createMpvEngine`. */
export function createEngineControls(deps: EngineControlsDeps): EngineControls {
  let pendingSeeks = 0;
  let speedInFlight = false;
  let pendingSpeed: { slot: MediaSlot | undefined; rate: number } | undefined;

  const flushPendingSpeed = (): void => {
    if (deps.isReleased() || !deps.hasLive() || pendingSeeks > 0 || speedInFlight || !pendingSpeed)
      return;
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
      pendingSeeks += 1;
    },
    onCommandSettled(command) {
      const isSeek = command[0] === 'seek';
      const isSpeed = command[0] === 'set_property' && command[1] === 'speed';
      if (isSeek) pendingSeeks = Math.max(0, pendingSeeks - 1);
      if (isSpeed) speedInFlight = false;
      if (isSeek || isSpeed) flushPendingSpeed();
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
      if (Number.isFinite(volume)) setProp('volume', volume);
    },
    setAudioDelay(delaySec) {
      if (Number.isFinite(delaySec)) setProp('audio-delay', delaySec);
    },
    setSubtitleDelay(delaySec) {
      if (Number.isFinite(delaySec)) setProp('sub-delay', delaySec);
    },
    setAudioDevice(device) {
      if (device.length > 0) setProp('audio-device', device);
    },
    setDeinterlace(enabled) {
      setProp('deinterlace', enabled ? 'yes' : 'no');
    },
  };
}

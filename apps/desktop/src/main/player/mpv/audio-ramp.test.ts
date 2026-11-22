import { describe, expect, it, vi } from 'vitest';
import { createAudioRamp, DEFAULT_AUDIO_RAMP_MS } from './audio-ramp.ts';

function setup(opts: { durationMs?: number; steps?: number } = {}) {
  const volumes: number[] = [];
  const restores: number[] = [];
  const ramp = createAudioRamp({
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    setVolume: (v) => volumes.push(v),
    restoreVolume: (v) => restores.push(v),
    ...opts,
  });
  return { ramp, volumes, restores };
}

describe('createAudioRamp (#254)', () => {
  it('defaults to 175 ms ramp duration', () => {
    expect(DEFAULT_AUDIO_RAMP_MS).toBe(175);
  });

  it('rampPause steps volume down to 0 over 175 ms, invokes onComplete, then restores savedVolume', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes } = setup();
      ramp.onProperty('volume', 80);
      const events: string[] = [];
      const ramp2 = createAudioRamp({
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        setVolume: (v) => {
          volumes.push(v);
          events.push(`vol:${v}`);
        },
      });
      ramp2.onProperty('volume', 80);

      ramp2.rampPause(() => events.push('pause'));
      expect(ramp2.isRamping).toBe(true);
      expect(events).toEqual([]);

      vi.advanceTimersByTime(150);
      expect(events.includes('pause')).toBe(false);
      expect(volumes.length).toBe(6);
      expect(volumes.every((v, i) => v < (i === 0 ? 80 : (volumes[i - 1] ?? 80)))).toBe(true);

      vi.advanceTimersByTime(25);
      expect(ramp2.isRamping).toBe(false);
      expect(ramp2.isAttenuated).toBe(false);
      expect(events.slice(-3)).toEqual(['vol:0', 'pause', 'vol:80']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rampPlay sets volume to 0, invokes onUnpause, and ramps smoothly up to savedVolume over 175 ms', () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const volumes: number[] = [];
      const ramp = createAudioRamp({
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        setVolume: (v) => {
          volumes.push(v);
          events.push(`vol:${v}`);
        },
      });
      ramp.onProperty('volume', 70);

      ramp.rampPlay(() => events.push('unpause'));
      expect(events).toEqual(['vol:0', 'unpause']);
      expect(ramp.isRamping).toBe(true);

      vi.advanceTimersByTime(150);
      expect(volumes).toHaveLength(7);
      expect(volumes.at(-1)).toBeLessThan(70);

      vi.advanceTimersByTime(25);
      expect(ramp.isRamping).toBe(false);
      expect(ramp.isAttenuated).toBe(false);
      expect(volumes.at(-1)).toBe(70);
      for (let i = 1; i < volumes.length; i += 1) {
        expect(volumes[i]).toBeGreaterThan(volumes[i - 1] ?? -1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores self-emitted ramp echoes during and right after ramp while honoring external volume changes', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes } = setup();
      ramp.onProperty('volume', 60);
      ramp.rampPause(() => undefined);

      vi.advanceTimersByTime(50);
      // Echoes arriving mid-ramp must not overwrite savedVolume
      for (const v of volumes) ramp.onProperty('volume', v);
      expect(ramp.savedVolume).toBe(60);

      vi.advanceTimersByTime(125);
      // Delayed echoes arriving after ramp completes must still be ignored
      ramp.onProperty('volume', 0);
      ramp.onProperty('volume', 60);
      expect(ramp.savedVolume).toBe(60);

      // Genuine external volume change updates savedVolume
      ramp.onProperty('volume', 45);
      expect(ramp.savedVolume).toBe(45);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips volume stepping when muted, when savedVolume is 0, or when durationMs is 0', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes } = setup();
      ramp.onProperty('mute', true);
      const onPause = vi.fn();
      const onPlay = vi.fn();
      ramp.rampPause(onPause);
      ramp.rampPlay(onPlay);
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(volumes).toEqual([]);

      ramp.onProperty('mute', false);
      ramp.onProperty('volume', 0);
      ramp.rampPause(onPause);
      ramp.rampPlay(onPlay);
      expect(onPause).toHaveBeenCalledTimes(2);
      expect(onPlay).toHaveBeenCalledTimes(2);
      expect(volumes).toEqual([]);

      const instant = setup({ durationMs: 0 });
      const cb = vi.fn();
      instant.ramp.rampPause(cb);
      instant.ramp.rampPlay(cb);
      expect(cb).toHaveBeenCalledTimes(2);
      expect(instant.volumes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rapid pause -> play interrupts down-ramp and smoothly ramps up from current level without snapping to 0', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes } = setup();
      ramp.onProperty('volume', 100);
      const onPause = vi.fn();
      const onPlay = vi.fn();

      ramp.rampPause(onPause);
      vi.advanceTimersByTime(75); // 3 steps down
      expect(volumes).toHaveLength(3);
      const lowPoint = volumes.at(-1) ?? 100;
      expect(lowPoint).toBeGreaterThan(0);
      expect(lowPoint).toBeLessThan(100);

      ramp.rampPlay(onPlay);
      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onPause).not.toHaveBeenCalled();
      expect(volumes).not.toContain(0);

      vi.advanceTimersByTime(200);
      expect(onPause).not.toHaveBeenCalled();
      expect(volumes).not.toContain(0);
      expect(volumes.at(-1)).toBe(100);
      expect(ramp.isRamping).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rapid play -> pause interrupts up-ramp and smoothly ramps down from current attenuated level', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes } = setup();
      ramp.onProperty('volume', 100);
      const onPlay = vi.fn();
      const onPause = vi.fn();

      ramp.rampPlay(onPlay);
      vi.advanceTimersByTime(75); // 3 steps up from 0
      const peak = volumes.at(-1) ?? 0;
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThan(100);

      ramp.rampPause(onPause);
      vi.advanceTimersByTime(200);
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(volumes.slice(-2)).toEqual([0, 100]);
      expect(ramp.isRamping).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel(true) cancels pending timers and restores savedVolume only if attenuated; cancel(false) skips restore', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes, restores } = setup();
      ramp.onProperty('volume', 75);

      // Cancel when idle is a no-op
      ramp.cancel(true);
      expect(restores).toEqual([]);

      // Cancel mid-ramp with restoreVolume=true restores savedVolume
      const onPause = vi.fn();
      ramp.rampPause(onPause);
      vi.advanceTimersByTime(50);
      const countAtCancel = volumes.length;
      ramp.cancel(true);
      expect(restores).toEqual([75]);
      expect(ramp.isRamping).toBe(false);
      expect(ramp.isAttenuated).toBe(false);

      vi.advanceTimersByTime(300);
      expect(onPause).not.toHaveBeenCalled();
      expect(volumes).toHaveLength(countAtCancel);

      // Cancel mid-ramp with restoreVolume=false emits no restore
      ramp.rampPlay(() => undefined);
      vi.advanceTimersByTime(50);
      ramp.cancel(false);
      expect(restores).toEqual([75]);
      vi.advanceTimersByTime(300);
      expect(ramp.isRamping).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onUserVolume cancels active ramp and adopts new volume without restoring old level', () => {
    vi.useFakeTimers();
    try {
      const { ramp, volumes, restores } = setup();
      ramp.onProperty('volume', 90);
      const onPause = vi.fn();
      ramp.rampPause(onPause);
      vi.advanceTimersByTime(50);

      ramp.onUserVolume(40);
      expect(ramp.savedVolume).toBe(40);
      expect(ramp.isRamping).toBe(false);
      expect(restores).toEqual([]);

      const countAfterUser = volumes.length;
      const delayedEcho = volumes[0];
      expect(delayedEcho).toBeDefined();
      if (delayedEcho !== undefined) ramp.onProperty('volume', delayedEcho);
      expect(ramp.savedVolume).toBe(40);

      vi.advanceTimersByTime(300);
      expect(onPause).not.toHaveBeenCalled();
      expect(volumes).toHaveLength(countAfterUser);
    } finally {
      vi.useRealTimers();
    }
  });
});

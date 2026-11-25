import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFileReadaheadPersistence,
  createReadaheadController,
  createReadaheadTierStore,
  DEFAULT_READAHEAD_STEP_DOWN_HEALTHY_MS,
  DEFAULT_READAHEAD_STEP_UP_COOLDOWN_MS,
  MAX_READAHEAD_STORE_ENTRIES,
  READAHEAD_TIER_SECS,
  streamFingerprint,
} from './readahead.ts';

describe('streamFingerprint (#196)', () => {
  it('returns a deterministic SHA-256 hex fingerprint stripping credentials, query and fragment', () => {
    const a = streamFingerprint(
      'http://alice:secret@Stream.Example.COM:8080/live/ch1.ts?token=abc#frag',
    );
    const b = streamFingerprint('https://stream.example.com:8080/live/ch1.ts?token=xyz');
    const c = streamFingerprint('http://stream.example.com:8080/live/ch2.ts');

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('alice');
    expect(a).not.toContain('secret');
    expect(a).not.toContain('example.com');
    expect(a).not.toContain('ch1');
  });

  it('handles malformed urls safely without throwing or exposing raw text', () => {
    const fp = streamFingerprint('not a valid url?token=secret');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain('secret');
  });
});

describe('createReadaheadTierStore (#196)', () => {
  it('enforces bounded LRU capacity of 500 entries and promotes on get()', () => {
    expect(MAX_READAHEAD_STORE_ENTRIES).toBe(500);
    const store = createReadaheadTierStore({ maxEntries: 3 });
    const k1 = streamFingerprint('http://h.test/1.ts');
    const k2 = streamFingerprint('http://h.test/2.ts');
    const k3 = streamFingerprint('http://h.test/3.ts');
    const k4 = streamFingerprint('http://h.test/4.ts');

    store.set(k1, 'normal');
    store.set(k2, 'aggressive');
    store.set(k3, 'fast');
    expect(store.size).toBe(3);

    // Promote k1 so k2 becomes the LRU entry
    expect(store.get(k1)).toBe('normal');
    store.set(k4, 'normal');
    expect(store.size).toBe(3);
    expect(store.get(k2)).toBeUndefined();
    expect(store.get(k1)).toBe('normal');
    expect(store.get(k3)).toBe('fast');
    expect(store.get(k4)).toBe('normal');
  });

  it('persists only URL-free fingerprints via injectable JSON persistence and rejects raw URLs', () => {
    let rawJson: string | undefined;
    const persistence = {
      read: () => rawJson,
      write: (data: string) => {
        rawJson = data;
      },
    };
    const fp = streamFingerprint('http://user:pass@iptv.example/live/user/pass/1001.ts?tok=99');
    const store1 = createReadaheadTierStore({ persistence });
    store1.set(fp, 'aggressive');
    // Raw URL keys must be rejected
    store1.set('http://user:pass@iptv.example/raw.ts', 'normal');
    expect(store1.size).toBe(1);
    expect(rawJson).toBeDefined();
    expect(rawJson).not.toContain('iptv.example');
    expect(rawJson).not.toContain('pass');
    expect(rawJson).not.toContain('http://');

    const store2 = createReadaheadTierStore({ persistence });
    expect(store2.get(fp)).toBe('aggressive');
  });

  it('tolerates corrupt JSON and persistence read/write failures', () => {
    const corrupt = createReadaheadTierStore({
      persistence: {
        read: () => '{broken json',
        write: () => {
          throw new Error('disk full');
        },
      },
    });
    expect(corrupt.size).toBe(0);
    expect(() => corrupt.set(streamFingerprint('http://h.test/1.ts'), 'normal')).not.toThrow();

    const throwingRead = createReadaheadTierStore({
      persistence: {
        read: () => {
          throw new Error('EACCES');
        },
        write: () => undefined,
      },
    });
    expect(throwingRead.size).toBe(0);
  });

  it('createFileReadaheadPersistence reads and writes a JSON file safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-readahead-'));
    try {
      const filePath = join(dir, 'nested', 'mpv-readahead.json');
      const persistence = createFileReadaheadPersistence(filePath);
      expect(persistence.read()).toBeUndefined();

      const fp = streamFingerprint('http://alice:pw@provider.test/live/1.ts');
      const store = createReadaheadTierStore({ persistence });
      store.set(fp, 'normal');

      const disk = readFileSync(filePath, 'utf8');
      expect(disk).toContain(fp);
      expect(disk).not.toContain('alice');
      expect(disk).not.toContain('provider.test');

      const reloaded = createReadaheadTierStore({ persistence });
      expect(reloaded.get(fp)).toBe('normal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createReadaheadController (#196)', () => {
  it('defines fast (4s), normal (8s) and aggressive (20s) tiers', () => {
    expect(READAHEAD_TIER_SECS).toEqual({ fast: 4, normal: 8, aggressive: 20 });
    expect(DEFAULT_READAHEAD_STEP_UP_COOLDOWN_MS).toBe(10_000);
    expect(DEFAULT_READAHEAD_STEP_DOWN_HEALTHY_MS).toBe(120_000);
  });

  it('ignores paused-for-cache and low cache during opening, seeking, and paused states', () => {
    let nowMs = 1_000;
    const applied: number[] = [];
    const ctrl = createReadaheadController({
      now: () => nowMs,
      onApply: (secs) => applied.push(secs),
    });

    ctrl.beginMedia('http://sim.test/live/1001.ts');
    expect(applied).toEqual([4]);

    // During opening (before playback-restart & firstFrame)
    ctrl.property('paused-for-cache', true);
    ctrl.property('demuxer-cache-duration', 0.1);
    expect(ctrl.tier).toBe('fast');

    // Only playback-restart without firstFrame -> still ignored
    ctrl.onPlaybackRestart();
    ctrl.property('paused-for-cache', true);
    expect(ctrl.tier).toBe('fast');

    // Now steady playback starts
    ctrl.onFirstFrame();

    // While paused -> ignored
    ctrl.property('pause', true);
    ctrl.property('paused-for-cache', true);
    ctrl.property('demuxer-cache-duration', 0.05);
    expect(ctrl.tier).toBe('fast');
    ctrl.property('pause', false);

    // While seeking -> ignored
    ctrl.property('seeking', true);
    ctrl.property('paused-for-cache', true);
    ctrl.property('demuxer-cache-duration', 0.05);
    expect(ctrl.tier).toBe('fast');
    ctrl.property('seeking', false);

    // Now in steady playback -> steps up!
    nowMs += 1_000;
    ctrl.property('paused-for-cache', true);
    expect(ctrl.tier).toBe('normal');
    expect(applied).toEqual([4, 8]);
  });

  it('enforces step-up cooldown so a single burst never skips tiers', () => {
    let nowMs = 10_000;
    const applied: number[] = [];
    const ctrl = createReadaheadController({
      now: () => nowMs,
      onApply: (secs) => applied.push(secs),
    });

    ctrl.beginMedia('http://sim.test/live/1001.ts');
    ctrl.onPlaybackRestart();
    ctrl.onFirstFrame();

    // First stall: fast -> normal
    ctrl.property('paused-for-cache', true);
    expect(ctrl.tier).toBe('normal');
    expect(applied).toEqual([4, 8]);

    // Burst within 10 s cooldown must NOT skip to aggressive
    nowMs += 9_999;
    ctrl.property('paused-for-cache', true);
    ctrl.property('demuxer-cache-duration', 0.1);
    expect(ctrl.tier).toBe('normal');
    expect(applied).toEqual([4, 8]);

    // After cooldown expires: normal -> aggressive
    nowMs += 1;
    ctrl.property('paused-for-cache', true);
    expect(ctrl.tier).toBe('aggressive');
    expect(applied).toEqual([4, 8, 20]);

    // Further stalls at max tier are no-ops
    nowMs += 20_000;
    ctrl.property('paused-for-cache', true);
    expect(ctrl.tier).toBe('aggressive');
    expect(applied).toEqual([4, 8, 20]);
  });

  it('steps up on critically low demuxer-cache-duration during steady playback', () => {
    const nowMs = 5_000;
    const applied: number[] = [];
    const ctrl = createReadaheadController({
      now: () => nowMs,
      onApply: (secs) => applied.push(secs),
    });

    ctrl.beginMedia('http://sim.test/live/1002.ts');
    ctrl.onPlaybackRestart();
    ctrl.onFirstFrame();

    ctrl.property('demuxer-cache-duration', 0.4);
    expect(ctrl.tier).toBe('normal');
    expect(applied).toEqual([4, 8]);
  });

  it('steps down from aggressive to normal after 120 s of healthy cache and keeps normal sticky', () => {
    let nowMs = 1_000;
    const applied: number[] = [];
    const store = createReadaheadTierStore();
    const url = 'http://sim.test/live/1003.ts';
    store.set(streamFingerprint(url), 'aggressive');

    const ctrl = createReadaheadController({
      now: () => nowMs,
      store,
      onApply: (secs) => applied.push(secs),
    });

    ctrl.beginMedia(url);
    expect(ctrl.tier).toBe('aggressive');
    expect(applied).toEqual([20]);
    ctrl.onPlaybackRestart();
    ctrl.onFirstFrame();

    // Healthy cache >= 15s (20 * 0.75) starts healthy timer
    ctrl.property('demuxer-cache-duration', 16);
    nowMs += 100_000;
    ctrl.property('demuxer-cache-duration', 15.5);
    expect(ctrl.tier).toBe('aggressive');

    // Dip below 75% resets healthy timer -> prevents oscillation
    nowMs += 10_000;
    ctrl.property('demuxer-cache-duration', 14);
    nowMs += 20_000;
    ctrl.property('demuxer-cache-duration', 16);
    expect(ctrl.tier).toBe('aggressive');

    // Full 120 s sustained healthy after restart -> steps down to normal (8 s)
    nowMs += 119_999;
    ctrl.property('demuxer-cache-duration', 16);
    expect(ctrl.tier).toBe('aggressive');

    nowMs += 1;
    ctrl.property('demuxer-cache-duration', 16);
    expect(ctrl.tier).toBe('normal');
    expect(applied).toEqual([20, 8]);
    expect(store.get(streamFingerprint(url))).toBe('normal');

    // Once at normal, sustained healthy cache must NOT step back down to fast (prevents 2-min re-stall loops)
    ctrl.property('demuxer-cache-duration', 6.5);
    nowMs += 120_000;
    ctrl.property('demuxer-cache-duration', 6.5);
    expect(ctrl.tier).toBe('normal');
    expect(applied).toEqual([20, 8]);
    expect(store.get(streamFingerprint(url))).toBe('normal');
  });

  it('remembers stepped-up tier per stream fingerprint across channel switches', () => {
    let nowMs = 1_000;
    const applied: number[] = [];
    const store = createReadaheadTierStore();
    const ctrl = createReadaheadController({
      now: () => nowMs,
      store,
      onApply: (secs) => applied.push(secs),
    });

    // Stream A stalls and steps up to normal (8s)
    ctrl.beginMedia('http://sim.test/live/chA.ts?token=1');
    ctrl.onPlaybackRestart();
    ctrl.onFirstFrame();
    ctrl.property('paused-for-cache', true);
    expect(applied).toEqual([4, 8]);

    // Switch to Stream B -> starts at fast (4s)
    nowMs += 1_000;
    ctrl.beginMedia('http://sim.test/live/chB.ts');
    expect(applied).toEqual([4, 8, 4]);

    // Switch back to Stream A (with different query token) -> restores normal (8s)
    nowMs += 1_000;
    ctrl.beginMedia('http://sim.test/live/chA.ts?token=2');
    expect(applied).toEqual([4, 8, 4, 8]);
  });

  it('re-applies target readahead on every beginMedia even when two consecutive streams share the same tier', () => {
    const applied: number[] = [];
    const ctrl = createReadaheadController({
      now: () => 1_000,
      onApply: (secs) => applied.push(secs),
    });

    ctrl.beginMedia('http://sim.test/live/chB.ts');
    ctrl.beginMedia('http://sim.test/live/chC.ts');
    expect(applied).toEqual([4, 4]);
  });
});

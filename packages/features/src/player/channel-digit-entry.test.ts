import { DIGIT_KEYS, type Key } from '@elv/focus-core';
import type { PlaybackTimers } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_DIGIT_TIMEOUT_MS,
  createChannelDigitBuffer,
  digitKeyToChar,
  isHiddenOsdPassthroughKey,
  MAX_CHANNEL_DIGITS,
  resolveChannelJump,
} from './channel-digit-entry';

function createFakeTimers() {
  let nextId = 1;
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  const timers: PlaybackTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number);
    },
  };
  return {
    timers,
    scheduled,
    fireAll() {
      const entries = [...scheduled.entries()];
      scheduled.clear();
      for (const [, entry] of entries) entry.fn();
    },
  };
}

describe('channel-digit-entry and hidden-OSD passthrough helpers (#439)', () => {
  it('maps digit0..digit9 to character digits and ignores non-digits', () => {
    for (let i = 0; i <= 9; i += 1) {
      expect(digitKeyToChar(`digit${i}` as Key)).toBe(String(i));
    }
    expect(digitKeyToChar('select')).toBeUndefined();
    expect(digitKeyToChar('channelUp')).toBeUndefined();
  });

  it('classifies hidden-OSD passthrough transport/media/digit keys vs directional/select/menu keys', () => {
    const passthrough: Key[] = [
      'playPause',
      'play',
      'pause',
      'rewind',
      'fastForward',
      'stop',
      'next',
      'previous',
      'captions',
      'audioTrack',
      'info',
      'guide',
      'lastChannel',
      ...DIGIT_KEYS,
    ];
    for (const k of passthrough) {
      expect(isHiddenOsdPassthroughKey(k)).toBe(true);
    }

    const wakeOnly: Key[] = [
      'up',
      'down',
      'left',
      'right',
      'select',
      'menu',
      'search',
      'back',
      'channelUp',
      'channelDown',
    ];
    for (const k of wakeOnly) {
      expect(isHiddenOsdPassthroughKey(k)).toBe(false);
    }
  });

  it('buffers up to 4 digits, debounces with injected timers, commits positive numbers, and cancels cleanly', () => {
    const fake = createFakeTimers();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const buf = createChannelDigitBuffer({
      timers: () => fake.timers,
      onChange,
      onCommit,
    });

    expect(CHANNEL_DIGIT_TIMEOUT_MS).toBe(1_200);
    expect(MAX_CHANNEL_DIGITS).toBe(4);

    buf.push('1');
    expect(buf.value).toBe('1');
    expect(onChange).toHaveBeenLastCalledWith('1');
    expect(fake.scheduled.size).toBe(1);

    buf.push('0');
    buf.push('4');
    buf.push('2');
    // 5th digit is ignored past MAX_CHANNEL_DIGITS
    buf.push('9');
    expect(buf.value).toBe('1042');
    expect(onChange).toHaveBeenLastCalledWith('1042');
    expect(fake.scheduled.size).toBe(1);
    expect([...fake.scheduled.values()][0]?.ms).toBe(CHANNEL_DIGIT_TIMEOUT_MS);

    fake.fireAll();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1042);
    expect(buf.value).toBe('');
    expect(onChange).toHaveBeenLastCalledWith('');

    // Zero-only entry clears without committing channel 0
    buf.push('0');
    buf.push('0');
    fake.fireAll();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(buf.value).toBe('');

    // Cancel drops timer and clears buffer without committing
    buf.push('7');
    expect(fake.scheduled.size).toBe(1);
    buf.cancel();
    expect(fake.scheduled.size).toBe(0);
    expect(buf.value).toBe('');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('resolves channel jumps via catalog.channelByNumber or 1-based playlist fallback', async () => {
    const ch2 = { itemKey: 'ch:2', sourceId: 's1', title: '2. Sports', kind: 'live' as const };
    const current = {
      itemKey: 'ch:1',
      sourceId: 's1',
      title: '1. News',
      kind: 'live' as const,
      playlist: {
        count: 2,
        currentIndex: 0,
        getAt: async (i: number) => (i === 1 ? ch2 : undefined),
        onChangeIndex: vi.fn(),
      },
    };
    const byNumber = vi.fn(async (num: number, sourceId?: string) =>
      num === 9
        ? {
            id: 9,
            key: 'ch:9',
            kind: 'live' as const,
            sourceId: sourceId ?? 's1',
            providerId: '9',
            name: '9. Doc',
            logo: null,
            rating: null,
            year: null,
            num: 9,
          }
        : null,
    );

    const fromCatalog = await resolveChannelJump(9, current, { channelByNumber: byNumber });
    expect(fromCatalog?.entry.itemKey).toBe('ch:9');

    // #7: when channelByNumber returns null (e.g. M3U without tvg-chno), fall back to 1-based playlist
    const fromNullFallback = await resolveChannelJump(2, current, { channelByNumber: byNumber });
    expect(fromNullFallback).toEqual({ entry: ch2, index: 1 });
    expect(await resolveChannelJump(99, current, { channelByNumber: byNumber })).toBeNull();

    const fromPlaylist = await resolveChannelJump(2, current, {});
    expect(fromPlaylist).toEqual({ entry: ch2, index: 1 });
    expect(await resolveChannelJump(5, current, {})).toBeNull();

    // #4: rejected catalog.channelByNumber and playlist.getAt resolve cleanly to null
    const failingCatalog = {
      channelByNumber: vi.fn(async () => {
        throw new Error('db busy');
      }),
    };
    expect(await resolveChannelJump(2, current, failingCatalog)).toBeNull();
    const failingPlaylistTarget = {
      ...current,
      playlist: {
        ...current.playlist,
        getAt: async () => {
          throw new Error('page load failed');
        },
      },
    };
    expect(await resolveChannelJump(2, failingPlaylistTarget, {})).toBeNull();
  });
});

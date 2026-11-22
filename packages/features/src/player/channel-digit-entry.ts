import type { CatalogService } from '@elv/data';
import { isDigitKey, type Key } from '@elv/focus-core';
import type { PlaybackTimers } from '@elv/playback';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import { itemRowToPlayableEntry } from './player-overlay-model';

/** Debounce window in ms before buffered live-TV channel digits commit a channel jump (`#439`). */
export const CHANNEL_DIGIT_TIMEOUT_MS = 1_200;

/** Maximum number of consecutive channel digits accumulated before timeout (`#439`). */
export const MAX_CHANNEL_DIGITS = 4;

const HIDDEN_OSD_PASSTHROUGH_KEYS: ReadonlySet<Key> = new Set([
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
  'lastChannel',
]);

const DIGIT_KEY_CHARS: Readonly<Partial<Record<Key, string>>> = {
  digit0: '0',
  digit1: '1',
  digit2: '2',
  digit3: '3',
  digit4: '4',
  digit5: '5',
  digit6: '6',
  digit7: '7',
  digit8: '8',
  digit9: '9',
};

/** Maps a remote digit key (`digit0`–`digit9`) to its ASCII digit character (`'0'`–`'9'`). */
export function digitKeyToChar(key: Key): string | undefined {
  return DIGIT_KEY_CHARS[key];
}

/**
 * Whether `key` must wake a hidden TV OSD AND pass through to execute immediately rather than
 * being swallowed on the first press (`#439`).
 */
export function isHiddenOsdPassthroughKey(key: Key): boolean {
  return HIDDEN_OSD_PASSTHROUGH_KEYS.has(key) || isDigitKey(key);
}

/** Dependencies of {@link createChannelDigitBuffer}. */
export interface ChannelDigitBufferDeps {
  readonly timers: () => PlaybackTimers;
  readonly onChange: (digits: string) => void;
  readonly onCommit: (channelNumber: number) => void;
  readonly timeoutMs?: number;
  readonly maxDigits?: number;
}

/** Bounded multi-digit live channel entry buffer backed by injected {@link PlaybackTimers}. */
export interface ChannelDigitBuffer {
  readonly value: string;
  push(digit: string): void;
  cancel(): void;
}

/** Creates a live-TV direct channel number entry buffer (`1_200 ms` debounce, up to 4 digits). */
export function createChannelDigitBuffer(deps: ChannelDigitBufferDeps): ChannelDigitBuffer {
  const timeoutMs = deps.timeoutMs ?? CHANNEL_DIGIT_TIMEOUT_MS;
  const maxDigits = deps.maxDigits ?? MAX_CHANNEL_DIGITS;
  let value = '';
  let handle: unknown;

  const clearTimer = (): void => {
    if (handle === undefined) return;
    deps.timers().clearTimeout(handle);
    handle = undefined;
  };

  const commit = (): void => {
    clearTimer();
    const raw = value;
    if (raw.length === 0) return;
    value = '';
    deps.onChange('');
    const num = Number.parseInt(raw, 10);
    if (Number.isFinite(num) && num > 0) deps.onCommit(num);
  };

  return {
    get value() {
      return value;
    },
    push(digit: string) {
      if (value.length >= maxDigits) return;
      value += digit;
      deps.onChange(value);
      clearTimer();
      handle = deps.timers().setTimeout(commit, timeoutMs);
    },
    cancel() {
      clearTimer();
      if (value.length === 0) return;
      value = '';
      deps.onChange('');
    },
  };
}

/** Resolves a direct live channel number via `catalog.channelByNumber` or 1-based playlist fallback. */
export async function resolveChannelJump(
  channelNumber: number,
  current: PlayTarget,
  catalog: Partial<Pick<CatalogService, 'channelByNumber'>>,
): Promise<{ readonly entry: PlayableEntry; readonly index?: number } | null> {
  try {
    if (catalog.channelByNumber !== undefined) {
      const row = await catalog.channelByNumber(channelNumber, current.sourceId);
      if (row !== null) return { entry: itemRowToPlayableEntry(row, current) };
    }
    const pl = current.playlist;
    if (pl !== undefined && channelNumber >= 1 && channelNumber <= pl.count) {
      const index = channelNumber - 1;
      const entry = await pl.getAt(index);
      return entry !== undefined ? { entry, index } : null;
    }
    return null;
  } catch {
    return null;
  }
}

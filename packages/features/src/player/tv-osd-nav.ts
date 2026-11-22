import type { KeyEvent } from '@elv/focus-core';
import { isScrubKey } from './scrub-controller';

/** Logical OSD button identifiers navigable on TV when the OSD bar is focused. */
export type TvOsdAction =
  | 'back'
  | 'playPause'
  | 'seekBack'
  | 'seekForward'
  | 'prevChannel'
  | 'channelList'
  | 'info'
  | 'tracks'
  | 'settings'
  | 'nextEpisode'
  | 'retry';

/** Which OSD buttons are mounted; mirrors the guards in `PlayerOsd`. */
export interface TvOsdAvailability {
  readonly isVod: boolean;
  readonly hasService: boolean;
  readonly hasTracks: boolean;
  readonly showRetry: boolean;
  readonly hasSettings?: boolean;
  readonly hasInfo?: boolean;
  readonly hasChannelList?: boolean;
  readonly hasNextEpisode?: boolean;
  readonly hasPreviousChannel?: boolean;
}

const ORDER: readonly TvOsdAction[] = [
  'back',
  'seekBack',
  'playPause',
  'seekForward',
  'prevChannel',
  'channelList',
  'info',
  'tracks',
  'settings',
  'nextEpisode',
  'retry',
];

/** Mounted TV OSD buttons in on-screen order. */
export function availableTvOsdActions(a: TvOsdAvailability): TvOsdAction[] {
  const transport = a.isVod && a.hasService;
  return ORDER.filter((action) => {
    switch (action) {
      case 'back':
        return true;
      case 'prevChannel':
        return !a.isVod && a.hasService && a.hasPreviousChannel === true;
      case 'channelList':
        return !a.isVod && a.hasService && a.hasChannelList === true;
      case 'info':
        return a.hasService && a.hasInfo === true;
      case 'tracks':
        return a.hasTracks && a.hasService;
      case 'settings':
        return a.hasService && a.hasSettings === true;
      case 'nextEpisode':
        return a.isVod && a.hasService && a.hasNextEpisode === true;
      case 'retry':
        return a.showRetry;
      default:
        return transport;
    }
  });
}

/** Action focused when the OSD bar gains TV focus: tracks, then play/pause, then back. */
export function initialTvOsdAction(available: readonly TvOsdAction[]): TvOsdAction {
  if (available.includes('tracks')) return 'tracks';
  return available.includes('playPause') ? 'playPause' : 'back';
}

/** Keeps `action` if mounted, else the nearest earlier mounted button, else the first one. */
export function clampTvOsdAction(
  action: TvOsdAction,
  available: readonly TvOsdAction[],
): TvOsdAction {
  for (let i = ORDER.indexOf(action); i >= 0; i -= 1) {
    const candidate = ORDER[i] as TvOsdAction;
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? 'back';
}

/** Moves focus one mounted button left (`-1`) or right (`1`) from the clamped action. */
export function moveTvOsdAction(
  action: TvOsdAction,
  available: readonly TvOsdAction[],
  delta: 1 | -1,
): TvOsdAction {
  const idx = available.indexOf(clampTvOsdAction(action, available));
  return available[Math.max(0, Math.min(available.length - 1, idx + delta))] ?? 'back';
}

/** Result of routing a {@link KeyEvent} while the TV OSD bar holds focus. */
export type TvOsdKeyIntent =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus'; readonly action: TvOsdAction }
  | { readonly kind: 'activate'; readonly action: TvOsdAction };

/** Routes a focused-OSD key event to blur, horizontal move, or clamped activation. */
export function routeTvOsdKey(
  event: KeyEvent,
  action: TvOsdAction,
  available: readonly TvOsdAction[],
): TvOsdKeyIntent | null {
  if (event.kind === 'press' && event.key === 'up') return { kind: 'blur' };
  if (
    (event.kind === 'press' || event.kind === 'repeat') &&
    (event.key === 'left' || event.key === 'right')
  ) {
    return {
      kind: 'focus',
      action: moveTvOsdAction(action, available, event.key === 'right' ? 1 : -1),
    };
  }
  if (event.kind === 'press' && event.key === 'select') {
    return { kind: 'activate', action: clampTvOsdAction(action, available) };
  }
  return null;
}

/** Result of routing a {@link KeyEvent} while the TV VOD progress scrubber holds focus. */
export type TvScrubberKeyIntent =
  | { readonly kind: 'step'; readonly direction: 1 | -1; readonly stepKind: 'press' | 'repeat' }
  | { readonly kind: 'commitOrToggle' }
  | { readonly kind: 'togglePlayPause' }
  | { readonly kind: 'toOsd' }
  | { readonly kind: 'blur' };

/** Routes a focused-scrubber key event with horizontal seek-trapping (`#297`). */
export function routeTvScrubberKey(event: KeyEvent): TvScrubberKeyIntent | null {
  if ((event.kind === 'press' || event.kind === 'repeat') && isScrubKey(event.key)) {
    return {
      kind: 'step',
      direction: event.key === 'left' || event.key === 'rewind' ? -1 : 1,
      stepKind: event.kind,
    };
  }
  if (event.kind !== 'press') return null;
  if (event.key === 'select') return { kind: 'commitOrToggle' };
  if (event.key === 'playPause') return { kind: 'togglePlayPause' };
  if (event.key === 'down') return { kind: 'toOsd' };
  if (event.key === 'up') return { kind: 'blur' };
  return null;
}

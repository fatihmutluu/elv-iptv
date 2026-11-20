import type { KeyEvent } from '@elv/focus-core';

/** Logical OSD button identifiers navigable on TV when the VOD OSD bar is focused. */
export type TvOsdAction = 'back' | 'playPause' | 'seekBack' | 'seekForward' | 'tracks' | 'retry';

/** Which OSD buttons are mounted; mirrors the guards in `PlayerOsd`. */
export interface TvOsdAvailability {
  readonly isVod: boolean;
  readonly hasService: boolean;
  readonly hasTracks: boolean;
  readonly showRetry: boolean;
}

const ORDER: readonly TvOsdAction[] = [
  'back',
  'playPause',
  'seekBack',
  'seekForward',
  'tracks',
  'retry',
];

/** Mounted TV OSD buttons in on-screen order. */
export function availableTvOsdActions(a: TvOsdAvailability): TvOsdAction[] {
  const transport = a.isVod && a.hasService;
  return ORDER.filter((action) => {
    switch (action) {
      case 'back':
        return true;
      case 'tracks':
        return a.hasTracks && a.hasService;
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

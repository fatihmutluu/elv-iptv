import {
  DEFAULT_KEY_BINDINGS,
  type Key,
  type KeyEvent,
  type KeymapOverrides,
  type KeyTrigger,
  REMAPPABLE_ACTIONS,
  type RemapContext,
  type RemappableActionId,
} from '@elv/focus-core';

/** Outcome of evaluating a key event against sparse user {@link KeymapOverrides}. */
export type RemapEvaluation =
  | { readonly status: 'remapped'; readonly actionId: RemappableActionId }
  | { readonly status: 'suppressed' }
  | { readonly status: 'default'; readonly actionId: RemappableActionId | null };

function triggerMatchesEvent(
  trigger: KeyTrigger | null | undefined,
  event: Pick<KeyEvent, 'key' | 'kind'>,
): boolean {
  return trigger != null && trigger.key === event.key && trigger.kind === event.kind;
}

/**
 * Evaluates an interpreted {@link KeyEvent} within `context` against sparse {@link KeymapOverrides},
 * matching `resolveRemappedAction` precedence strictly:
 *
 * 1. Checks context-local (`player` / `live`) active bindings FIRST (both overridden and default).
 * 2. Only falls back to `'global'` active bindings if no local action claims that event.
 * 3. Returns `{ status: 'suppressed' }` when no active binding matched, yet the event matches the
 *    *default* trigger of an action in `context` or `'global'` that the user explicitly unbound
 *    (`null`) or moved to a different key.
 * 4. Returns `{ status: 'default', actionId: null }` otherwise.
 */
export function evaluateRemappedEvent(
  overrides: KeymapOverrides,
  context: RemapContext,
  event: Pick<KeyEvent, 'key' | 'kind'>,
): RemapEvaluation {
  if (event.kind !== 'press' && event.kind !== 'long') {
    return { status: 'default', actionId: null };
  }

  for (const meta of REMAPPABLE_ACTIONS) {
    if (meta.context !== context) continue;
    const hasOverride = Object.hasOwn(overrides, meta.id);
    const effective = hasOverride ? overrides[meta.id] : DEFAULT_KEY_BINDINGS[meta.id];
    if (triggerMatchesEvent(effective, event)) {
      return hasOverride
        ? { status: 'remapped', actionId: meta.id }
        : { status: 'default', actionId: meta.id };
    }
  }

  if (context !== 'global') {
    for (const meta of REMAPPABLE_ACTIONS) {
      if (meta.context !== 'global') continue;
      const hasOverride = Object.hasOwn(overrides, meta.id);
      const effective = hasOverride ? overrides[meta.id] : DEFAULT_KEY_BINDINGS[meta.id];
      if (triggerMatchesEvent(effective, event)) {
        return hasOverride
          ? { status: 'remapped', actionId: meta.id }
          : { status: 'default', actionId: meta.id };
      }
    }
  }

  for (const meta of REMAPPABLE_ACTIONS) {
    if (meta.context !== context && meta.context !== 'global') continue;
    if (!Object.hasOwn(overrides, meta.id)) continue;
    if (triggerMatchesEvent(DEFAULT_KEY_BINDINGS[meta.id], event)) {
      return { status: 'suppressed' };
    }
  }

  return { status: 'default', actionId: null };
}

/** Maps a DOM `KeyboardEvent.key` string to its logical remote {@link Key}, or `null` if unmapped. */
export function mapWebKeyToRemoteKey(webKey: string): Key | null {
  switch (webKey) {
    case 'Escape':
    case 'Backspace':
      return 'back';
    case 'Enter':
      return 'select';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case ' ':
      return 'playPause';
    case 'm':
    case 'M':
      return 'menu';
    case 'g':
    case 'G':
      return 'guide';
    case 'i':
    case 'I':
      return 'info';
    case 'p':
    case 'P':
      return 'lastChannel';
    case 's':
    case 'S':
      return 'search';
    case 'c':
    case 'C':
      return 'captions';
    case 'a':
    case 'A':
      return 'audioTrack';
    case 'r':
    case 'R':
      return 'colorRed';
    case 'y':
    case 'Y':
      return 'colorYellow';
    case 'b':
    case 'B':
      return 'colorBlue';
    case 'PageUp':
      return 'channelUp';
    case 'PageDown':
      return 'channelDown';
    default:
      return null;
  }
}

const KEY_DISPLAY_LABELS: Readonly<Partial<Record<Key, string>>> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  select: 'OK',
  back: 'Back',
  menu: 'Menu',
  playPause: 'Play / Pause',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  rewind: 'Rewind',
  fastForward: 'Fast Forward',
  next: 'Next',
  previous: 'Previous',
  captions: 'CC',
  audioTrack: 'Audio',
  guide: 'Guide',
  info: 'Info',
  search: 'Search',
  lastChannel: 'Prev Ch',
  channelUp: 'CH+',
  channelDown: 'CH−',
  colorRed: 'Red',
  colorGreen: 'Green',
  colorYellow: 'Yellow',
  colorBlue: 'Blue',
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

/** Returns a concise human-readable hardware key label for {@link Key} badges in Settings (`#33`). */
export function formatRemoteKeyLabel(key: Key): string {
  return KEY_DISPLAY_LABELS[key] ?? key;
}

import {
  DEFAULT_KEY_BINDINGS,
  type Key,
  type KeyEvent,
  type KeymapOverrides,
  type KeyTrigger,
  REMAPPABLE_ACTIONS,
  type RemapContext,
  type RemappableActionId,
  resolveRemappedAction,
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
 * Evaluates an interpreted {@link KeyEvent} within `context` against sparse {@link KeymapOverrides}.
 *
 * - Returns `{ status: 'remapped', actionId }` when the event matches an explicit user override in
 *   `context` (or `'global'`).
 * - Returns `{ status: 'suppressed' }` when the event matches the *default* trigger of an action
 *   that the user explicitly unbound (`null`) or moved to a different key, preventing the old
 *   default binding from firing.
 * - Returns `{ status: 'default', actionId }` otherwise, preserving built-in defaults seamlessly.
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
    if (Object.hasOwn(overrides, meta.id) && triggerMatchesEvent(overrides[meta.id], event)) {
      return { status: 'remapped', actionId: meta.id };
    }
  }

  if (context !== 'global') {
    for (const meta of REMAPPABLE_ACTIONS) {
      if (meta.context !== 'global') continue;
      if (Object.hasOwn(overrides, meta.id) && triggerMatchesEvent(overrides[meta.id], event)) {
        return { status: 'remapped', actionId: meta.id };
      }
    }
  }

  const resolvedDefault = resolveRemappedAction(overrides, context, event);
  if (resolvedDefault !== null) {
    return { status: 'default', actionId: resolvedDefault };
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

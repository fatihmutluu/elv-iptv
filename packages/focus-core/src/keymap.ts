import { ARROW_KEYS, COLOR_KEYS, DIGIT_KEYS, isDigitKey, type Key, type KeyEvent } from './keys';

/** Scope in which a remappable remote-control action is evaluated (`#33`). */
export type RemapContext = 'player' | 'live' | 'global';

/** Remappable action identifiers across player, live TV, and global navigation (`#33`). */
export type RemappableActionId =
  | 'player.togglePlayPause'
  | 'player.seekBack'
  | 'player.seekForward'
  | 'player.channelUp'
  | 'player.channelDown'
  | 'player.lastChannel'
  | 'player.openChannelDrawer'
  | 'player.openSettings'
  | 'player.cycleAudioTrack'
  | 'player.cycleSubtitleTrack'
  | 'player.toggleMute'
  | 'player.openInfo'
  | 'player.toggleGuide'
  | 'live.lastChannel'
  | 'live.toggleGuide'
  | 'live.openSearch'
  | 'live.toggleFavorite'
  | 'global.openSearch'
  | 'global.openGuide'
  | 'global.openHome';

/** Physical remote key + gesture kind bound to a remappable action. */
export interface KeyTrigger {
  readonly key: Key;
  readonly kind: 'press' | 'long';
}

/** Sparse user overrides mapping remappable actions to custom triggers (`null` = explicitly unbound). */
export type KeymapOverrides = Partial<Record<RemappableActionId, KeyTrigger | null>>;

/** Metadata describing one remappable action and its default trigger. */
export interface RemapActionMeta {
  readonly id: RemappableActionId;
  readonly context: RemapContext;
  readonly defaultTrigger: KeyTrigger | null;
}

/** Validation outcome returned by {@link validateKeyBinding}. */
export type KeyBindingValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'immutable-nav-key' | 'unknown-action' | 'invalid-trigger';
    };

const ALL_KEYS: ReadonlySet<string> = new Set<Key>([
  ...ARROW_KEYS,
  'select',
  'back',
  'menu',
  'playPause',
  'play',
  'pause',
  'stop',
  'rewind',
  'fastForward',
  'next',
  'previous',
  'captions',
  'audioTrack',
  'guide',
  'info',
  'search',
  'lastChannel',
  'channelUp',
  'channelDown',
  ...COLOR_KEYS,
  ...DIGIT_KEYS,
]);

const IMMUTABLE_NAV_KEYS: ReadonlySet<Key> = new Set<Key>([...ARROW_KEYS, 'select', 'back']);
const DEFAULT_LONG_PRESS_KEYS: readonly Key[] = Object.freeze(['select', 'back', ...ARROW_KEYS]);

/** Ordered catalog of all remappable actions and their default bindings. */
export const REMAPPABLE_ACTIONS: readonly RemapActionMeta[] = Object.freeze([
  {
    id: 'player.togglePlayPause',
    context: 'player',
    defaultTrigger: { key: 'playPause', kind: 'press' },
  },
  { id: 'player.seekBack', context: 'player', defaultTrigger: { key: 'rewind', kind: 'press' } },
  {
    id: 'player.seekForward',
    context: 'player',
    defaultTrigger: { key: 'fastForward', kind: 'press' },
  },
  {
    id: 'player.channelUp',
    context: 'player',
    defaultTrigger: { key: 'channelUp', kind: 'press' },
  },
  {
    id: 'player.channelDown',
    context: 'player',
    defaultTrigger: { key: 'channelDown', kind: 'press' },
  },
  {
    id: 'player.lastChannel',
    context: 'player',
    defaultTrigger: { key: 'lastChannel', kind: 'press' },
  },
  {
    id: 'player.openChannelDrawer',
    context: 'player',
    defaultTrigger: { key: 'menu', kind: 'press' },
  },
  {
    id: 'player.openSettings',
    context: 'player',
    defaultTrigger: { key: 'colorBlue', kind: 'press' },
  },
  {
    id: 'player.cycleAudioTrack',
    context: 'player',
    defaultTrigger: { key: 'audioTrack', kind: 'press' },
  },
  {
    id: 'player.cycleSubtitleTrack',
    context: 'player',
    defaultTrigger: { key: 'captions', kind: 'press' },
  },
  {
    id: 'player.toggleMute',
    context: 'player',
    defaultTrigger: { key: 'colorYellow', kind: 'press' },
  },
  { id: 'player.openInfo', context: 'player', defaultTrigger: { key: 'info', kind: 'press' } },
  { id: 'player.toggleGuide', context: 'player', defaultTrigger: { key: 'guide', kind: 'press' } },
  {
    id: 'live.lastChannel',
    context: 'live',
    defaultTrigger: { key: 'lastChannel', kind: 'press' },
  },
  { id: 'live.toggleGuide', context: 'live', defaultTrigger: { key: 'guide', kind: 'press' } },
  { id: 'live.openSearch', context: 'live', defaultTrigger: { key: 'search', kind: 'press' } },
  {
    id: 'live.toggleFavorite',
    context: 'live',
    defaultTrigger: { key: 'colorRed', kind: 'press' },
  },
  { id: 'global.openSearch', context: 'global', defaultTrigger: { key: 'search', kind: 'press' } },
  { id: 'global.openGuide', context: 'global', defaultTrigger: { key: 'guide', kind: 'press' } },
  {
    id: 'global.openHome',
    context: 'global',
    defaultTrigger: { key: 'colorGreen', kind: 'press' },
  },
]);

const ACTION_META_BY_ID: ReadonlyMap<RemappableActionId, RemapActionMeta> = new Map(
  REMAPPABLE_ACTIONS.map((meta) => [meta.id, meta]),
);

const ACTIONS_BY_CONTEXT: Readonly<Record<RemapContext, readonly RemapActionMeta[]>> = {
  player: REMAPPABLE_ACTIONS.filter((a) => a.context === 'player'),
  live: REMAPPABLE_ACTIONS.filter((a) => a.context === 'live'),
  global: REMAPPABLE_ACTIONS.filter((a) => a.context === 'global'),
};

/** Default trigger map indexed by {@link RemappableActionId}. */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<RemappableActionId, KeyTrigger | null>> =
  Object.freeze(
    Object.fromEntries(REMAPPABLE_ACTIONS.map((meta) => [meta.id, meta.defaultTrigger])) as Record<
      RemappableActionId,
      KeyTrigger | null
    >,
  );

function triggersEqual(a: KeyTrigger | null, b: KeyTrigger | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.key === b.key && a.kind === b.kind;
}

function isValidKey(value: unknown): value is Key {
  return typeof value === 'string' && ALL_KEYS.has(value);
}

/**
 * Returns `true` when `trigger` is a short press on a core directional or confirm/back key
 * (`up`, `down`, `left`, `right`, `select`, `back`). Those triggers are immutable so users can
 * never orphan Settings or menu navigation.
 */
export function isImmutableNavTrigger(trigger: KeyTrigger): boolean {
  return trigger.kind === 'press' && IMMUTABLE_NAV_KEYS.has(trigger.key);
}

/** Validates whether `trigger` may be bound to `actionId`. */
export function validateKeyBinding(
  actionId: RemappableActionId,
  trigger: KeyTrigger | null,
): KeyBindingValidation {
  if (!ACTION_META_BY_ID.has(actionId)) {
    return { ok: false, reason: 'unknown-action' };
  }
  if (trigger === null) {
    return { ok: true };
  }
  if (!isValidKey(trigger.key) || (trigger.kind !== 'press' && trigger.kind !== 'long')) {
    return { ok: false, reason: 'invalid-trigger' };
  }
  if (isImmutableNavTrigger(trigger)) {
    return { ok: false, reason: 'immutable-nav-key' };
  }
  return { ok: true };
}

/** Returns the effective {@link KeyTrigger} for `actionId`, falling back to {@link DEFAULT_KEY_BINDINGS}. */
export function resolveKeyTrigger(
  overrides: KeymapOverrides,
  actionId: RemappableActionId,
): KeyTrigger | null {
  if (Object.hasOwn(overrides, actionId)) {
    const custom = overrides[actionId];
    if (custom !== undefined) return custom;
  }
  return DEFAULT_KEY_BINDINGS[actionId] ?? null;
}

/**
 * Resolves an interpreted {@link KeyEvent} within `context`, checking context-scoped bindings first
 * and falling back to `'global'` bindings. Ignores `'repeat'` events.
 */
export function resolveRemappedAction(
  overrides: KeymapOverrides,
  context: RemapContext,
  event: Pick<KeyEvent, 'key' | 'kind'>,
): RemappableActionId | null {
  if (event.kind !== 'press' && event.kind !== 'long') return null;

  for (const meta of ACTIONS_BY_CONTEXT[context]) {
    const trigger = resolveKeyTrigger(overrides, meta.id);
    if (trigger !== null && trigger.key === event.key && trigger.kind === event.kind) {
      return meta.id;
    }
  }

  if (context !== 'global') {
    for (const meta of ACTIONS_BY_CONTEXT.global) {
      const trigger = resolveKeyTrigger(overrides, meta.id);
      if (trigger !== null && trigger.key === event.key && trigger.kind === event.kind) {
        return meta.id;
      }
    }
  }

  return null;
}

/**
 * Returns the action IDs in the same `context` or `'global'` that would be displaced by binding
 * `trigger` to `actionId`.
 */
export function findConflictingActions(
  overrides: KeymapOverrides,
  actionId: RemappableActionId,
  trigger: KeyTrigger,
): RemappableActionId[] {
  const targetMeta = ACTION_META_BY_ID.get(actionId);
  if (targetMeta === undefined) return [];

  const conflicts: RemappableActionId[] = [];
  for (const other of REMAPPABLE_ACTIONS) {
    if (other.id === actionId) continue;
    if (other.context !== targetMeta.context && other.context !== 'global') continue;
    const current = resolveKeyTrigger(overrides, other.id);
    if (triggersEqual(current, trigger)) {
      conflicts.push(other.id);
    }
  }
  return conflicts;
}

/**
 * Returns a new sparse {@link KeymapOverrides} binding `actionId` to `trigger` (`null` unbinds).
 * Rejects invalid or immutable navigation triggers by returning `overrides` unchanged.
 * Automatically displaces conflicting actions in the same context or `'global'`, and prunes entries
 * equal to their default so persisted overrides stay minimal.
 */
export function setKeyBinding(
  overrides: KeymapOverrides,
  actionId: RemappableActionId,
  trigger: KeyTrigger | null,
): KeymapOverrides {
  if (!validateKeyBinding(actionId, trigger).ok) return overrides;

  const next: Record<string, KeyTrigger | null> = { ...overrides };

  if (trigger !== null) {
    const conflicts = findConflictingActions(overrides, actionId, trigger);
    for (const conflictId of conflicts) {
      if (DEFAULT_KEY_BINDINGS[conflictId] === null) {
        delete next[conflictId];
      } else {
        next[conflictId] = null;
      }
    }
  }

  const normalizedTrigger = trigger === null ? null : { key: trigger.key, kind: trigger.kind };
  if (triggersEqual(normalizedTrigger, DEFAULT_KEY_BINDINGS[actionId])) {
    delete next[actionId];
  } else {
    next[actionId] = normalizedTrigger;
  }

  return next as KeymapOverrides;
}

/**
 * Removes any user override for `actionId`, restoring its default binding and displacing any
 * other action in the same or conflicting (`global` vs local) context rebound onto that trigger.
 */
export function resetKeyBinding(
  overrides: KeymapOverrides,
  actionId: RemappableActionId,
): KeymapOverrides {
  if (!Object.hasOwn(overrides, actionId)) return overrides;
  const targetMeta = ACTION_META_BY_ID.get(actionId);
  const next: Record<string, KeyTrigger | null> = { ...overrides };
  delete next[actionId];

  if (targetMeta !== undefined && targetMeta.defaultTrigger !== null) {
    const defaultTrigger = targetMeta.defaultTrigger;
    for (const other of REMAPPABLE_ACTIONS) {
      if (other.id === actionId) continue;
      const sameContext = other.context === targetMeta.context;
      const crossGlobal =
        (targetMeta.context === 'global' && other.context !== 'global') ||
        (targetMeta.context !== 'global' && other.context === 'global');
      if (!sameContext && !crossGlobal) continue;
      if (crossGlobal && triggersEqual(other.defaultTrigger, defaultTrigger)) continue;
      const current = resolveKeyTrigger(overrides, other.id);
      if (triggersEqual(current, defaultTrigger)) {
        if (DEFAULT_KEY_BINDINGS[other.id] === null) {
          delete next[other.id];
        } else {
          next[other.id] = null;
        }
      }
    }
  }

  return next as KeymapOverrides;
}

/** Returns an empty {@link KeymapOverrides} object restoring all default bindings. */
export function resetAllKeyBindings(): KeymapOverrides {
  return {};
}

/**
 * Collects the union of default interpreter `longKeys` (`select`, `back`, arrows) and any non-digit
 * key currently bound with `kind: 'long'`, so `useKeyInterpreter` can recognize custom long presses.
 */
export function collectLongPressKeys(overrides: KeymapOverrides = {}): readonly Key[] {
  const keys = new Set<Key>(DEFAULT_LONG_PRESS_KEYS);
  for (const meta of REMAPPABLE_ACTIONS) {
    const trigger = resolveKeyTrigger(overrides, meta.id);
    if (trigger !== null && trigger.kind === 'long' && !isDigitKey(trigger.key)) {
      keys.add(trigger.key);
    }
  }
  return [...keys];
}

/**
 * Strictly sanitizes an untrusted value into a sparse {@link KeymapOverrides} object, discarding
 * unknown action IDs, invalid triggers, immutable navigation overrides, and entries equal to default.
 */
export function parseKeymapOverrides(raw: unknown): KeymapOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, KeyTrigger | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ACTION_META_BY_ID.has(key as RemappableActionId)) continue;
    const actionId = key as RemappableActionId;

    if (value === null) {
      if (DEFAULT_KEY_BINDINGS[actionId] !== null) {
        result[actionId] = null;
      }
      continue;
    }

    if (typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as { key?: unknown; kind?: unknown };
    if (!isValidKey(candidate.key)) continue;
    if (candidate.kind !== 'press' && candidate.kind !== 'long') continue;

    const trigger: KeyTrigger = { key: candidate.key, kind: candidate.kind };
    if (!validateKeyBinding(actionId, trigger).ok) continue;
    if (triggersEqual(trigger, DEFAULT_KEY_BINDINGS[actionId])) continue;

    result[actionId] = trigger;
  }

  return result as KeymapOverrides;
}

import type { AttemptToken, MediaKind } from '@elv/playback';

/** An mpv playlist entry that is between its `start-file` and `end-file`. */
interface CurrentEntry {
  entryId: number;
  token: AttemptToken;
  kind: MediaKind;
}

/** Maps mpv playlist entry ids to the token of the `load` that created them. */
export interface EntryTable {
  /** Records the entry a `loadfile` created, with its command's token. */
  bind(entryId: number, token: AttemptToken, kind: MediaKind): void;
  /** `start-file`: the entry becomes current. Unbound entries are ignored. */
  started(entryId: number): void;
  /** `end-file`: the entry is forgotten and stops being current. */
  ended(entryId: number): void;
  /** The entry between `start-file` and `end-file`, if any; property changes belong to it. */
  current(): CurrentEntry | undefined;
  tokenOf(entryId: number): AttemptToken | undefined;
  /** Gives the current entry a newer token (port contract: non-load commands adopt). */
  adopt(token: AttemptToken): void;
}

/** Creates an empty entry table. */
export function createEntryTable(): EntryTable {
  const entries = new Map<number, { token: AttemptToken; kind: MediaKind }>();
  let currentId: number | undefined;
  return {
    bind: (entryId, token, kind) => void entries.set(entryId, { token, kind }),
    started(entryId) {
      if (entries.has(entryId)) currentId = entryId;
    },
    ended(entryId) {
      entries.delete(entryId);
      if (currentId === entryId) currentId = undefined;
    },
    current() {
      const entry = currentId === undefined ? undefined : entries.get(currentId);
      return currentId === undefined || !entry ? undefined : { entryId: currentId, ...entry };
    },
    tokenOf: (entryId) => entries.get(entryId)?.token,
    adopt(token) {
      const entry = currentId === undefined ? undefined : entries.get(currentId);
      if (entry) entry.token = token;
    },
  };
}

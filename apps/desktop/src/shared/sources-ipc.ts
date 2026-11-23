/** IPC channels exposed by main for desktop source import ergonomics (`#51`, `#259`). */
export const SOURCES_CHANNELS = Object.freeze({
  readClipboardText: 'sources:read-clipboard-text',
  pickPlaylistFile: 'sources:pick-playlist-file',
  consumePendingPlaylists: 'sources:consume-pending-playlists',
  openPlaylistFile: 'sources:open-playlist-file',
} as const);

/** Maximum local playlist size accepted across IPC (64 MiB, `#51`). */
export const MAX_PICKED_PLAYLIST_BYTES = 64 * 1024 * 1024;

/** Local playlist file payload returned to the renderer (basename + bytes only; never a host path). */
export interface PickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Frozen `window.elv.sources` bridge exposed by the sandboxed Electron preload (`#51`, `#259`). */
export interface SourcesBridge {
  readClipboardText(): Promise<string | null>;
  pickPlaylistFile(): Promise<PickedPlaylistFile | null>;
  consumePendingPlaylistFiles(): Promise<PickedPlaylistFile[]>;
  onOpenPlaylistFile(listener: (file: PickedPlaylistFile) => void): () => void;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

/** Validates a reply from `sources:read-clipboard-text`. */
export function isClipboardTextReply(x: unknown): x is string | null {
  return x === null || typeof x === 'string';
}

/** Validates a single non-null {@link PickedPlaylistFile} payload (`#51`, `#259`). */
export function isPickedPlaylistFile(x: unknown): x is PickedPlaylistFile {
  if (!isRecord(x)) return false;
  const name = x['name'];
  const bytes = x['bytes'];
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 512 &&
    bytes instanceof Uint8Array &&
    bytes.byteLength <= MAX_PICKED_PLAYLIST_BYTES
  );
}

/** Validates a reply from `sources:pick-playlist-file`. */
export function isPickedPlaylistFileReply(x: unknown): x is PickedPlaylistFile | null {
  return x === null || isPickedPlaylistFile(x);
}

/** Validates a reply from `sources:consume-pending-playlists` (`#259`). */
export function isPickedPlaylistFileArrayReply(x: unknown): x is PickedPlaylistFile[] {
  return Array.isArray(x) && x.every(isPickedPlaylistFile);
}

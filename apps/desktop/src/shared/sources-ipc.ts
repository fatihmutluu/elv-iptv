/** IPC channels exposed by main for desktop source import ergonomics (`#51`, `#259`, Wave Q7). */
export const SOURCES_CHANNELS = Object.freeze({
  readClipboardText: 'sources:read-clipboard-text',
  pickPlaylistFile: 'sources:pick-playlist-file',
  consumePendingPlaylists: 'sources:consume-pending-playlists',
  openPlaylistFile: 'sources:open-playlist-file',
  ackPlaylistFile: 'sources:ack-playlist-file',
  readDroppedPlaylistPath: 'sources:read-dropped-playlist-path',
} as const);

/** Maximum local playlist size accepted across IPC (64 MiB, `#51`). */
export const MAX_PICKED_PLAYLIST_BYTES = 64 * 1024 * 1024;

/** Local playlist file payload returned to the renderer (basename + bytes only; never a host path). */
export interface PickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly deliveryId?: string;
}

/** Frozen `window.elv.sources` bridge exposed by the sandboxed Electron preload (`#51`, `#259`, Wave Q7). */
export interface SourcesBridge {
  readClipboardText(): Promise<string | null>;
  pickPlaylistFile(): Promise<PickedPlaylistFile | null>;
  consumePendingPlaylistFiles(): Promise<PickedPlaylistFile[]>;
  onOpenPlaylistFile(listener: (file: PickedPlaylistFile) => void): () => void;
  ackPlaylistFile?(deliveryId: string): Promise<void>;
  readDroppedPlaylistFile?(file: File): Promise<PickedPlaylistFile | null>;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

/** Validates an opaque delivery acknowledgement identifier sent over `sources:ack-playlist-file`. */
export function isPlaylistDeliveryId(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= 64 && !/[\r\n\0]/.test(x);
}

/** Validates a reply from `sources:read-clipboard-text`. */
export function isClipboardTextReply(x: unknown): x is string | null {
  return x === null || typeof x === 'string';
}

/** Validates a single non-null {@link PickedPlaylistFile} payload (`#51`, `#259`). */
export function isPickedPlaylistFile(x: unknown): x is PickedPlaylistFile {
  if (!isRecord(x)) return false;
  const name = x['name'];
  const bytes = x['bytes'];
  const deliveryId = x['deliveryId'];
  if (deliveryId !== undefined && !isPlaylistDeliveryId(deliveryId)) return false;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 512 &&
    bytes instanceof Uint8Array &&
    bytes.byteLength <= MAX_PICKED_PLAYLIST_BYTES
  );
}

/** Validates a reply from `sources:pick-playlist-file` or `sources:read-dropped-playlist-path`. */
export function isPickedPlaylistFileReply(x: unknown): x is PickedPlaylistFile | null {
  return x === null || isPickedPlaylistFile(x);
}

/** Validates a reply from `sources:consume-pending-playlists` (`#259`). */
export function isPickedPlaylistFileArrayReply(x: unknown): x is PickedPlaylistFile[] {
  return Array.isArray(x) && x.every(isPickedPlaylistFile);
}

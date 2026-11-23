import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { LocalPlaylistStore } from '@elv/data';

/** Maximum local playlist size accepted by the sandboxed store (64 MiB, `#51`). */
export const MAX_LOCAL_PLAYLIST_BYTES = 64 * 1024 * 1024;

const SAFE_SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function resolvePlaylistPath(playlistsDir: string, sourceId: string): string {
  if (
    typeof sourceId !== 'string' ||
    !SAFE_SOURCE_ID_RE.test(sourceId) ||
    sourceId === '.' ||
    sourceId === '..' ||
    sourceId.includes('..')
  ) {
    throw new Error('Invalid local playlist sourceId');
  }
  const root = resolve(playlistsDir);
  const target = resolve(root, `${sourceId}.m3u`);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error('Local playlist path escapes sandbox directory');
  }
  return target;
}

/**
 * Sandboxed local M3U byte store under `<userDataDir>/playlists/<sourceId>.m3u` (`#51`).
 * Enforces strict sourceId sanitization, path-traversal guards, symlink refusal, and a 64 MiB cap.
 */
export function createLocalPlaylistStore(
  userDataDir: string,
  opts?: { readonly maxBytes?: number; readonly platform?: NodeJS.Platform },
): LocalPlaylistStore {
  const playlistsDir = join(userDataDir, 'playlists');
  const maxBytes = opts?.maxBytes ?? MAX_LOCAL_PLAYLIST_BYTES;
  const platform = opts?.platform ?? process.platform;

  return {
    async write(sourceId: string, bytes: Uint8Array): Promise<void> {
      const target = resolvePlaylistPath(playlistsDir, sourceId);
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('Local playlist bytes must be a Uint8Array');
      }
      if (bytes.byteLength > maxBytes) {
        throw new Error(`Local playlist exceeds ${maxBytes} byte size limit`);
      }
      await mkdir(playlistsDir, { recursive: true, mode: 0o700 });
      const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      try {
        await writeFile(tmp, bytes, { mode: 0o600 });
        if (platform !== 'win32') {
          await chmod(tmp, 0o600).catch(() => undefined);
        }
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async openRead(sourceId: string): Promise<AsyncIterable<Uint8Array> | undefined> {
      const target = resolvePlaylistPath(playlistsDir, sourceId);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error('Refused non-file or symlink in local playlist store');
      }
      if (info.size > maxBytes) {
        throw new Error(`Local playlist exceeds ${maxBytes} byte size limit`);
      }

      const stream = createReadStream(target, { highWaterMark: 64 * 1024 });
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          let readTotal = 0;
          try {
            for await (const chunk of stream) {
              const bytes =
                chunk instanceof Uint8Array
                  ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                  : Buffer.from(chunk as string);
              readTotal += bytes.byteLength;
              if (readTotal > maxBytes) {
                throw new Error(`Local playlist exceeds ${maxBytes} byte size limit`);
              }
              yield bytes;
            }
          } finally {
            if (!stream.destroyed) stream.destroy();
          }
        },
      };
    },

    async remove(sourceId: string): Promise<void> {
      const target = resolvePlaylistPath(playlistsDir, sourceId);
      await rm(target, { force: true });
    },
  };
}

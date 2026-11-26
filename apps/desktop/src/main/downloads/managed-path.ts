import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_DOWNLOAD_EXTENSIONS, isValidManagedDownloadFileName } from '@elv/domain';
import { isManagedDownloadFileUrlShape } from '../../shared/downloads-ipc.ts';

export { isManagedDownloadFileUrlShape };

const DEFAULT_DOWNLOAD_EXTENSION = '.mp4';
const MAX_SLUG_CHARS = 48;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Returns the app-private managed downloads directory (`<userData>/downloads`). */
export function getManagedDownloadsDir(userDataDir: string): string {
  return path.join(userDataDir, 'downloads');
}

/** Normalizes an optional container extension to an allowlisted extension, defaulting to `.mp4`. */
function normalizeManagedDownloadExtension(extension?: string | null): string {
  if (typeof extension !== 'string') return DEFAULT_DOWNLOAD_EXTENSION;
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) return DEFAULT_DOWNLOAD_EXTENSION;
  const candidate = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return (ALLOWED_DOWNLOAD_EXTENSIONS as readonly string[]).includes(candidate)
    ? candidate
    : DEFAULT_DOWNLOAD_EXTENSION;
}

/**
 * Produces a deterministic, collision-resistant ASCII filename safe for the managed downloads directory
 * (`<slug>-<sha256-16><ext>`), guaranteed to pass {@link isValidManagedDownloadFileName}.
 */
export function sanitizeDownloadFileName(itemKey: string, extension?: string | null): string {
  const ext = normalizeManagedDownloadExtension(extension);
  const hash = createHash('sha256').update(itemKey, 'utf8').digest('hex').slice(0, 16);
  const rawSlug = itemKey
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, MAX_SLUG_CHARS);
  const slug = rawSlug.length > 0 ? rawSlug : 'vod';
  return `${slug}-${hash}${ext}`;
}

function isContainedPath(realRoot: string, resolvedTarget: string): boolean {
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (process.platform === 'win32') {
    return resolvedTarget.toLowerCase().startsWith(rootPrefix.toLowerCase());
  }
  return resolvedTarget.startsWith(rootPrefix);
}

/**
 * Verifies that `fileUrlOrPath` refers to an existing, non-symlink regular video file strictly
 * contained within `downloadsRoot` after `fs.realpath` canonicalization. Returns the canonical
 * absolute OS path on success, or `null` if rejected.
 */
export async function validateManagedDownloadPath(
  downloadsRoot: string,
  fileUrlOrPath: string,
): Promise<string | null> {
  if (
    typeof downloadsRoot !== 'string' ||
    downloadsRoot.trim().length === 0 ||
    typeof fileUrlOrPath !== 'string' ||
    fileUrlOrPath.length === 0 ||
    hasControlChar(fileUrlOrPath)
  ) {
    return null;
  }

  let candidatePath: string;
  if (/^file:/i.test(fileUrlOrPath)) {
    if (!isManagedDownloadFileUrlShape(fileUrlOrPath)) return null;
    try {
      candidatePath = fileURLToPath(fileUrlOrPath);
    } catch {
      return null;
    }
  } else {
    if (fileUrlOrPath.includes('?') || fileUrlOrPath.includes('#')) return null;
    if (fileUrlOrPath.split(/[/\\]/).some((seg) => seg === '..')) return null;
    candidatePath = fileUrlOrPath;
  }

  const candidateBase = path.basename(candidatePath);
  if (!isValidManagedDownloadFileName(candidateBase)) return null;

  try {
    const realRoot = await realpath(downloadsRoot);
    const linkStats = await lstat(candidatePath);
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) return null;

    const resolved = await realpath(candidatePath);
    if (!isContainedPath(realRoot, resolved)) return null;
    if (!isValidManagedDownloadFileName(path.basename(resolved))) return null;

    const resolvedStats = await lstat(resolved);
    if (resolvedStats.isSymbolicLink() || !resolvedStats.isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

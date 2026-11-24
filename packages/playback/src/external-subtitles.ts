import { originOf, sanitizeHeaders } from '@elv/domain';
import type { ExternalSubtitleTrack } from './engine';

/** Maximum accepted external subtitle URI length (`#308`). */
export const MAX_EXTERNAL_SUBTITLE_URI_LENGTH = 4096;

const MAX_EXTERNAL_SUBTITLE_ID_LENGTH = 256;
const MAX_EXTERNAL_SUBTITLE_LABEL_LENGTH = 128;
const MAX_EXTERNAL_SUBTITLE_LANGUAGE_LENGTH = 32;
const MAX_EXTERNAL_SUBTITLE_MIME_LENGTH = 128;

const MIME_TOKEN_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const CANONICAL_MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'text/vtt': 'text/vtt',
  'text/webvtt': 'text/vtt',
  'application/x-subrip': 'application/x-subrip',
  'text/srt': 'application/x-subrip',
  'text/x-srt': 'application/x-subrip',
  'application/srt': 'application/x-subrip',
  'text/x-ssa': 'text/x-ssa',
  'text/x-ass': 'text/x-ssa',
  'application/x-ssa': 'text/x-ssa',
  'application/x-ass': 'text/x-ssa',
  'application/ttml+xml': 'application/ttml+xml',
  'application/ttaf+xml': 'application/ttml+xml',
  'text/ttml': 'application/ttml+xml',
});

const EXTENSION_MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
  srt: 'application/x-subrip',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  ttml: 'application/ttml+xml',
  dfxp: 'application/ttml+xml',
  xml: 'application/ttml+xml',
});

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    out += value[i];
  }
  return out.trim();
}

/**
 * Validates that an external subtitle URI uses an allowed transport scheme (`http://`, `https://`,
 * `file://`, or `content://`), is non-empty, contains no ASCII control characters, and fits within
 * {@link MAX_EXTERNAL_SUBTITLE_URI_LENGTH} (`#308`).
 */
export function isAllowedExternalSubtitleUri(uri: string): boolean {
  if (
    typeof uri !== 'string' ||
    uri.length === 0 ||
    uri.length > MAX_EXTERNAL_SUBTITLE_URI_LENGTH
  ) {
    return false;
  }
  if (hasControlChar(uri)) return false;
  const trimmed = uri.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EXTERNAL_SUBTITLE_URI_LENGTH) return false;
  const sep = trimmed.indexOf('://');
  if (sep <= 0) return false;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return originOf(trimmed) !== undefined;
  }
  if (scheme === 'file' || scheme === 'content') {
    return trimmed.slice(sep + 3).trim().length > 0;
  }
  return false;
}

/**
 * Returns a fresh header record strictly scoped to an external subtitle request (`#308`).
 * Never inherits or merges primary stream headers.
 */
export function sanitizeExternalSubtitleHeaders(
  headers?: Readonly<Record<string, string>>,
): Record<string, string> {
  return sanitizeHeaders(headers);
}

/**
 * Resolves the canonical subtitle MIME type (`text/vtt`, `application/x-subrip`, `text/x-ssa`,
 * `application/ttml+xml`) from an optional explicit MIME hint or the URI file extension (`#32`).
 */
export function inferSubtitleMimeType(uri: string, explicitMime?: string): string {
  if (typeof explicitMime === 'string') {
    const cleaned = (stripControlChars(explicitMime).split(';', 1)[0] ?? '').trim().toLowerCase();
    if (cleaned.length > 0 && cleaned.length <= MAX_EXTERNAL_SUBTITLE_MIME_LENGTH) {
      if (Object.hasOwn(CANONICAL_MIME_ALIASES, cleaned)) {
        return CANONICAL_MIME_ALIASES[cleaned] as string;
      }
      if (cleaned !== 'application/octet-stream' && MIME_TOKEN_RE.test(cleaned)) {
        return cleaned;
      }
    }
  }
  const withoutHash = uri.split('#', 1)[0] ?? '';
  const pathPart = withoutHash.split('?', 1)[0] ?? '';
  const lastSlash = Math.max(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'));
  const fileName = lastSlash === -1 ? pathPart : pathPart.slice(lastSlash + 1);
  const dot = fileName.lastIndexOf('.');
  if (dot >= 0) {
    const ext = fileName.slice(dot + 1).toLowerCase();
    if (Object.hasOwn(EXTENSION_MIME_MAP, ext)) {
      return EXTENSION_MIME_MAP[ext] as string;
    }
  }
  return 'application/x-subrip';
}

/**
 * Validates and normalizes an external subtitle track descriptor, stripping control characters,
 * capping metadata lengths, inferring MIME type, and sanitizing track-scoped headers (`#308`, `#32`).
 * Returns `null` when `id` or `uri` is invalid.
 */
export function normalizeExternalSubtitleTrack(
  track: ExternalSubtitleTrack,
): ExternalSubtitleTrack | null {
  if (typeof track !== 'object' || track === null) return null;
  if (typeof track.id !== 'string' || typeof track.uri !== 'string') return null;
  const id = stripControlChars(track.id).slice(0, MAX_EXTERNAL_SUBTITLE_ID_LENGTH);
  if (id.length === 0) return null;
  if (!isAllowedExternalSubtitleUri(track.uri)) return null;
  const uri = track.uri.trim();
  const label =
    typeof track.label === 'string'
      ? stripControlChars(track.label).slice(0, MAX_EXTERNAL_SUBTITLE_LABEL_LENGTH)
      : '';
  const language =
    typeof track.language === 'string'
      ? stripControlChars(track.language).slice(0, MAX_EXTERNAL_SUBTITLE_LANGUAGE_LENGTH)
      : '';
  const mimeType = inferSubtitleMimeType(uri, track.mimeType);
  const cleanHeaders = sanitizeExternalSubtitleHeaders(track.headers);
  const hasHeaders = Object.keys(cleanHeaders).length > 0;
  return Object.freeze({
    id,
    uri,
    ...(label.length > 0 ? { label } : {}),
    ...(language.length > 0 ? { language } : {}),
    mimeType,
    ...(hasHeaders ? { headers: Object.freeze(cleanHeaders) } : {}),
  });
}

/** @internal Normalizes and deduplicates an external subtitle list by `id` and `uri`. */
export function normalizeExternalSubtitleList(
  tracks?: readonly ExternalSubtitleTrack[],
): readonly ExternalSubtitleTrack[] {
  if (tracks === undefined || tracks.length === 0) return Object.freeze([]);
  const out: ExternalSubtitleTrack[] = [];
  const seenIds = new Set<string>();
  const seenUris = new Set<string>();
  for (const raw of tracks) {
    const clean = normalizeExternalSubtitleTrack(raw);
    if (clean === null) continue;
    if (seenIds.has(clean.id) || seenUris.has(clean.uri)) continue;
    seenIds.add(clean.id);
    seenUris.add(clean.uri);
    out.push(clean);
  }
  return Object.freeze(out);
}

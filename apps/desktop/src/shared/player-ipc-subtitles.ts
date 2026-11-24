import {
  isSubtitleBgColor,
  isSubtitleEdgeStyle,
  isSubtitleFontSize,
  isSubtitleTextColor,
  isSubtitleVerticalPosition,
  type SubtitleStyleConfig,
} from '@elv/domain';
import type { ExternalSubtitleTrack } from '@elv/playback';

const MAX_EXTERNAL_SUBTITLE_ID_CHARS = 256;
const MAX_EXTERNAL_SUBTITLE_URI_CHARS = 4096;
const MAX_EXTERNAL_SUBTITLE_LABEL_CHARS = 128;
const MAX_EXTERNAL_SUBTITLE_LANG_CHARS = 32;
const MAX_EXTERNAL_SUBTITLE_MIME_CHARS = 128;

/** Maximum external subtitle tracks accepted in a single `LoadCommand.options.externalSubtitles` array. */
export const MAX_EXTERNAL_SUBTITLES_PER_LOAD = 16;

const SUBTITLE_STYLE_KEYS: ReadonlySet<string> = new Set([
  'fontSize',
  'textColor',
  'backgroundColor',
  'edgeStyle',
  'verticalPosition',
]);

const EXTERNAL_SUBTITLE_TRACK_KEYS: ReadonlySet<string> = new Set([
  'id',
  'uri',
  'label',
  'language',
  'mimeType',
  'headers',
]);

/** Allowed keys on an `addExternalSubtitle` IPC command. */
export const ADD_EXTERNAL_SUBTITLE_CMD_KEYS: ReadonlySet<string> = new Set([
  'name',
  'attempt',
  'track',
]);

/** Allowed keys on a `setSubtitleStyle` IPC command. */
export const SET_SUBTITLE_STYLE_CMD_KEYS: ReadonlySet<string> = new Set(['name', 'style']);

const isSafeRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Returns `true` when every own enumerable key of `obj` belongs to `allowed`. */
export function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

const isDesktopSubtitleUri = (x: unknown): x is string => {
  if (
    typeof x !== 'string' ||
    x.length === 0 ||
    x.length > MAX_EXTERNAL_SUBTITLE_URI_CHARS ||
    hasControlChar(x)
  ) {
    return false;
  }
  const trimmed = x.trim();
  if (trimmed.length === 0 || !/^(?:https?|file):[/][/]/i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.length > 0;
    }
    if (parsed.protocol === 'file:') {
      return parsed.pathname.length > 1;
    }
    return false;
  } catch {
    return false;
  }
};

/** Main/preload runtime guard for {@link SubtitleStyleConfig} (`#32`). */
export function isSubtitleStyleConfig(x: unknown): x is SubtitleStyleConfig {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, SUBTITLE_STYLE_KEYS)) return false;
  return (
    isSubtitleFontSize(x['fontSize']) &&
    isSubtitleTextColor(x['textColor']) &&
    isSubtitleBgColor(x['backgroundColor']) &&
    isSubtitleEdgeStyle(x['edgeStyle']) &&
    isSubtitleVerticalPosition(x['verticalPosition'])
  );
}

/** Main/preload runtime guard for {@link ExternalSubtitleTrack} (`#32`, `#308`). */
export function isExternalSubtitleTrack(
  x: unknown,
  isHeaders: (value: unknown) => boolean,
): x is ExternalSubtitleTrack {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, EXTERNAL_SUBTITLE_TRACK_KEYS)) return false;
  const id = x['id'];
  if (
    typeof id !== 'string' ||
    id.trim().length === 0 ||
    id.length > MAX_EXTERNAL_SUBTITLE_ID_CHARS ||
    hasControlChar(id)
  ) {
    return false;
  }
  if (!isDesktopSubtitleUri(x['uri'])) return false;
  if (
    x['label'] !== undefined &&
    (typeof x['label'] !== 'string' ||
      x['label'].length > MAX_EXTERNAL_SUBTITLE_LABEL_CHARS ||
      hasControlChar(x['label']))
  ) {
    return false;
  }
  if (
    x['language'] !== undefined &&
    (typeof x['language'] !== 'string' ||
      x['language'].length > MAX_EXTERNAL_SUBTITLE_LANG_CHARS ||
      hasControlChar(x['language']))
  ) {
    return false;
  }
  if (
    x['mimeType'] !== undefined &&
    (typeof x['mimeType'] !== 'string' ||
      x['mimeType'].length > MAX_EXTERNAL_SUBTITLE_MIME_CHARS ||
      hasControlChar(x['mimeType']))
  ) {
    return false;
  }
  if (x['headers'] !== undefined && !isHeaders(x['headers'])) return false;
  return true;
}

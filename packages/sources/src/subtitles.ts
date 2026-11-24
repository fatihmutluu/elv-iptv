import { containsRtlText, isolateBidiLines, stripSdhSubtitleLine } from './subtitles-bidi';
import { parseAss, parseSrtOrVtt, parseTtml, type RawSubtitleCue } from './subtitles-formats';

export { containsRtlText, isolateBidiLines, stripSdhSubtitleLine } from './subtitles-bidi';

/** Supported text subtitle formats parsed by `@elv/sources`. */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ttml';

/** A normalized, sanitized subtitle cue with millisecond timing and RTL metadata. */
export interface ParsedSubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly isRtl: boolean;
}

/** Result of parsing a subtitle file or payload. */
export interface ParsedSubtitleTrack {
  readonly format: SubtitleFormat;
  readonly cues: readonly ParsedSubtitleCue[];
  readonly warnings: readonly string[];
}

/** Options controlling format detection, SDH cleanup, bidi isolation, and size limits. */
export interface ParseSubtitlesOptions {
  readonly format?: SubtitleFormat;
  readonly filenameOrMime?: string;
  readonly filterSdh?: boolean;
  readonly isolateBidi?: boolean;
  readonly maxBytes?: number;
}

/** Default maximum subtitle payload size (4 MiB). */
export const DEFAULT_MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

const DETECT_SAMPLE_CHARS = 4096;
const SRT_TIMECODE_HINT_RE =
  /(?:^|\n)\s*\d{1,3}:\d{2}(?::\d{2})?(?:[.,:]\d+)?\s*(?:-+>|—>|–>)\s*\d{1,3}:\d{2}/;
const ASS_HEADER_RE = /(?:^|\n)\s*(?:\[script info\]|\[v4\+? styles\]|\[events\]|dialogue\s*:)/i;
const TTML_HEADER_RE = /<(?:[a-zA-Z0-9_-]+:)?tt\b|http:\/\/www\.w3\.org\/ns\/ttml/i;

function detectFormatFromHint(filenameOrMime: string | undefined): SubtitleFormat | null {
  if (!filenameOrMime) return null;
  const cleaned = filenameOrMime.split(/[;?#]/, 1)[0]?.trim().toLowerCase() ?? '';
  if (cleaned.length === 0) return null;

  if (cleaned === 'text/vtt' || cleaned.endsWith('.vtt')) return 'vtt';
  if (
    cleaned === 'application/x-subrip' ||
    cleaned === 'text/srt' ||
    cleaned === 'application/srt' ||
    cleaned.endsWith('.srt')
  ) {
    return 'srt';
  }
  if (
    cleaned === 'text/x-ssa' ||
    cleaned === 'text/x-ass' ||
    cleaned === 'application/x-ssa' ||
    cleaned.endsWith('.ass') ||
    cleaned.endsWith('.ssa')
  ) {
    return 'ass';
  }
  if (
    cleaned === 'application/ttml+xml' ||
    cleaned === 'text/ttml' ||
    cleaned.endsWith('.ttml') ||
    cleaned.endsWith('.dfxp') ||
    cleaned.endsWith('.xml')
  ) {
    return 'ttml';
  }
  return null;
}

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function truncateUtf8Bytes(
  content: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: '', truncated: content.length > 0 };
  }
  if (content.length * 3 <= maxBytes) {
    return { text: content, truncated: false };
  }

  let bytes = 0;
  let i = 0;
  while (i < content.length) {
    const cp = content.codePointAt(i);
    if (cp === undefined) break;
    const step = cp > 0xffff ? 2 : 1;
    const charBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + charBytes > maxBytes) {
      return { text: content.slice(0, i), truncated: true };
    }
    bytes += charBytes;
    i += step;
  }
  return { text: content, truncated: false };
}

/**
 * Detects a subtitle format from content headers/markers with optional filename or MIME fallback.
 * Returns `null` when neither the content nor the hint identifies a supported format.
 */
export function detectSubtitleFormat(
  content: string,
  filenameOrMime?: string,
): SubtitleFormat | null {
  const sample = stripLeadingBom(content)
    .slice(0, DETECT_SAMPLE_CHARS)
    .replace(/\r\n?/g, '\n')
    .trimStart();

  if (/^WEBVTT(?:[\s-]|$)/.test(sample)) return 'vtt';
  if (ASS_HEADER_RE.test(sample)) return 'ass';
  if (TTML_HEADER_RE.test(sample)) return 'ttml';

  const hintFormat = detectFormatFromHint(filenameOrMime);
  if (SRT_TIMECODE_HINT_RE.test(sample)) {
    return hintFormat === 'vtt' ? 'vtt' : 'srt';
  }
  return hintFormat;
}

function normalizeCueText(rawText: string, filterSdh: boolean): string {
  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const joined = lines.join('\n');
  if (joined.length === 0) return '';
  return filterSdh ? stripSdhSubtitleLine(joined) : joined;
}

/**
 * Parses SRT, WebVTT, ASS/SSA, or TTML subtitles tolerantly, sorting cues deterministically,
 * dropping empty post-sanitization cues, and applying RTL bidi isolation by default.
 */
export function parseSubtitles(
  content: string,
  options?: ParseSubtitlesOptions,
): ParsedSubtitleTrack {
  const warnings: string[] = [];
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_SUBTITLE_BYTES;
  const { text: bounded, truncated } = truncateUtf8Bytes(content, maxBytes);
  if (truncated) warnings.push('input-truncated');

  const normalized = stripLeadingBom(bounded).replace(/\r\n?/g, '\n');
  const detected = options?.format ?? detectSubtitleFormat(normalized, options?.filenameOrMime);

  if (detected === null) {
    if (normalized.trim().length > 0) warnings.push('unknown-format');
    return { format: 'srt', cues: [], warnings };
  }

  let rawCues: RawSubtitleCue[];
  if (detected === 'ass') {
    rawCues = parseAss(normalized, warnings);
  } else if (detected === 'ttml') {
    rawCues = parseTtml(normalized, warnings);
  } else {
    rawCues = parseSrtOrVtt(normalized, detected, warnings);
  }

  const filterSdh = options?.filterSdh === true;
  const applyBidi = options?.isolateBidi !== false;
  const cues: ParsedSubtitleCue[] = [];

  for (const raw of rawCues) {
    const cleaned = normalizeCueText(raw.text, filterSdh);
    if (cleaned.length === 0) continue;
    const isRtl = containsRtlText(cleaned);
    const text = applyBidi ? isolateBidiLines(cleaned) : cleaned;
    cues.push({ startMs: raw.startMs, endMs: raw.endMs, text, isRtl });
  }

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { format: detected, cues, warnings };
}

/**
 * Finds all active cues overlapping `positionMs` (`startMs <= positionMs && positionMs < endMs`).
 * Expects `cues` sorted by `startMs` (as returned by `parseSubtitles`); safe for overlapping cues.
 */
export function findActiveCues(
  cues: readonly ParsedSubtitleCue[],
  positionMs: number,
): readonly ParsedSubtitleCue[] {
  if (cues.length === 0 || !Number.isFinite(positionMs) || positionMs < 0) {
    return [];
  }

  // Binary search for the first index whose `startMs > positionMs`.
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid];
    if (cue && cue.startMs <= positionMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (lo === 0) return [];

  const active: ParsedSubtitleCue[] = [];
  for (let i = 0; i < lo; i++) {
    const cue = cues[i];
    if (cue && positionMs < cue.endMs) {
      active.push(cue);
    }
  }
  return active;
}

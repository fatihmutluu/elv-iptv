import { elvError, err, ok, type Result } from '@elv/domain';
import { type CalendarParts, utcMsToCalendarParts } from './timezone-offset';

const DAY_MS = 86_400_000;
const MAX_CATCHUP_URL_LENGTH = 4_096;
const TEMPLATE_TOKEN_RE =
  /\$\{(start|timestamp|end|duration|offset)\}|\{(utc|start|end|utcend|duration|offset|lutc|Y|m|d|H|M|S)\}/g;

/** Supported catch-up URL resolution modes across Xtream, Stalker, and M3U providers. */
export type CatchupMode = 'default' | 'append' | 'shift' | 'flussonic' | 'xc' | 'stalker';

/** Programme time window and optional archive availability flag for catch-up resolution. */
export interface CatchupProgrammeWindow {
  readonly startMs: number;
  readonly stopMs: number;
  readonly hasArchive?: boolean;
}

/** Discriminated input for {@link buildCatchupUrl}. */
export type BuildCatchupUrlInput =
  | {
      readonly mode: 'xc';
      /** Optional Xtream timeshift endpoint scheme (`'rest'` default, or `'legacy'` `/streaming/timeshift.php`). */
      readonly xcScheme?: 'rest' | 'legacy';
      readonly server: string;
      readonly username: string;
      readonly password: string;
      readonly streamId: number | string;
      readonly ext?: string;
      readonly serverTimezone?: string;
      readonly programme: CatchupProgrammeWindow;
      readonly catchupDays?: number | null;
      readonly nowMs: number;
    }
  | {
      readonly mode: 'default' | 'append' | 'shift' | 'flussonic' | 'stalker';
      readonly liveUrl: string;
      readonly catchupSource?: string | null;
      readonly serverTimezone?: string;
      readonly programme: CatchupProgrammeWindow;
      readonly catchupDays?: number | null;
      readonly nowMs: number;
    };

/** Parameters for {@link expandCatchupTemplate}. */
export interface CatchupTemplateParams {
  readonly startMs: number;
  readonly stopMs: number;
  readonly nowMs: number;
  readonly serverTimezone?: string;
}

/** Result of {@link isProgrammeWithinCatchupWindow}. */
export type CatchupWindowCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'catchup-unavailable' | 'catchup-expired' | 'catchup-future';
    };

function extractCalendarParts(epochMs: number, serverTimezone?: string): CalendarParts {
  return utcMsToCalendarParts(epochMs, serverTimezone);
}

function hasWhitespaceOrControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return /\s/.test(value);
}

function isValidHttpCatchupUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_CATCHUP_URL_LENGTH) return false;
  if (hasWhitespaceOrControlChar(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function normalizeXcCatchupServer(rawServer: string): string | null {
  const trimmed = rawServer.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CATCHUP_URL_LENGTH ||
    hasWhitespaceOrControlChar(trimmed)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0
  ) {
    return null;
  }
  const cleanPath = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|panel_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
  const base = `${parsed.origin}${cleanPath}`;
  return base.length <= MAX_CATCHUP_URL_LENGTH ? base : null;
}

function splitFragment(url: string): readonly [string, string] {
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return [url, ''];
  return [url.slice(0, hashIdx), url.slice(hashIdx)];
}

function appendQueryParams(baseUrl: string, params: string): string {
  const [withoutHash, hash] = splitFragment(baseUrl);
  if (withoutHash.endsWith('?') || withoutHash.endsWith('&')) {
    return `${withoutHash}${params}${hash}`;
  }
  const sep = withoutHash.includes('?') ? '&' : '?';
  return `${withoutHash}${sep}${params}${hash}`;
}

function buildFlussonicUrl(liveUrl: string, startSec: number, durationSec: number): string | null {
  const schemeEnd = liveUrl.indexOf('://');
  if (schemeEnd < 0) return null;
  const queryIdx = liveUrl.indexOf('?');
  const hashIdx = liveUrl.indexOf('#');
  const tailIdx =
    queryIdx >= 0 && hashIdx >= 0
      ? Math.min(queryIdx, hashIdx)
      : queryIdx >= 0
        ? queryIdx
        : hashIdx;
  const pathPart = tailIdx >= 0 ? liveUrl.slice(0, tailIdx) : liveUrl;
  const tail = tailIdx >= 0 ? liveUrl.slice(tailIdx) : '';
  const lastSlash = pathPart.lastIndexOf('/');
  const dir = lastSlash > schemeEnd + 2 ? pathPart.slice(0, lastSlash + 1) : `${pathPart}/`;
  const file = lastSlash > schemeEnd + 2 ? pathPart.slice(lastSlash + 1) : '';
  if (file.toLowerCase().endsWith('.m3u8')) {
    return `${dir}archive-${startSec}-${durationSec}.m3u8${tail}`;
  }
  return `${dir}timeshift_abs-${startSec}.ts${tail}`;
}

function joinAppendUrl(liveUrl: string, expandedSuffix: string): string {
  const [withoutHash, hash] = splitFragment(liveUrl);
  if (expandedSuffix.startsWith('?')) {
    const rest = expandedSuffix.slice(1);
    if (withoutHash.includes('?')) {
      const sep = withoutHash.endsWith('?') || withoutHash.endsWith('&') ? '' : '&';
      return `${withoutHash}${sep}${rest}${hash}`;
    }
    return `${withoutHash}?${rest}${hash}`;
  }
  if (expandedSuffix.startsWith('&')) {
    const rest = expandedSuffix.slice(1);
    if (withoutHash.includes('?')) {
      const sep = withoutHash.endsWith('?') || withoutHash.endsWith('&') ? '' : '&';
      return `${withoutHash}${sep}${rest}${hash}`;
    }
    return `${withoutHash}?${rest}${hash}`;
  }
  return `${withoutHash}${expandedSuffix}${hash}`;
}

/** Normalizes raw M3U/provider catch-up mode names into canonical {@link CatchupMode} values. */
export function normalizeCatchupMode(raw: string | null | undefined): CatchupMode | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return null;
  switch (normalized) {
    case 'default':
      return 'default';
    case 'append':
      return 'append';
    case 'shift':
      return 'shift';
    case 'flussonic':
    case 'flussonic-hls':
    case 'flussonic-ts':
    case 'fs':
      return 'flussonic';
    case 'xc':
    case 'xtream':
      return 'xc';
    case 'stalker':
      return 'stalker';
    default:
      return null;
  }
}

/** Checks whether a programme falls inside the channel's available catch-up retention window. */
export function isProgrammeWithinCatchupWindow(
  programme: CatchupProgrammeWindow,
  catchupDays: number | null | undefined,
  nowMs: number,
): CatchupWindowCheck {
  if (programme.hasArchive === false) {
    return { ok: false, reason: 'catchup-unavailable' };
  }
  if (catchupDays == null || !Number.isFinite(catchupDays) || catchupDays <= 0) {
    return { ok: false, reason: 'catchup-unavailable' };
  }
  if (
    !Number.isFinite(programme.startMs) ||
    !Number.isFinite(programme.stopMs) ||
    !Number.isFinite(nowMs) ||
    programme.stopMs <= programme.startMs
  ) {
    return { ok: false, reason: 'catchup-unavailable' };
  }
  if (programme.startMs > nowMs) {
    return { ok: false, reason: 'catchup-future' };
  }
  if (programme.stopMs < nowMs - catchupDays * DAY_MS) {
    return { ok: false, reason: 'catchup-expired' };
  }
  return { ok: true };
}

/** Formats an epoch-ms start timestamp as `YYYY-MM-DD:HH-mm` in the server's IANA timezone (or UTC). */
export function formatXtreamTimeshiftStart(startMs: number, serverTimezone?: string): string {
  const parts = extractCalendarParts(startMs, serverTimezone);
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

/** Expands epoch and calendar catch-up template placeholders in a single pass. */
export function expandCatchupTemplate(template: string, params: CatchupTemplateParams): string {
  const startSec = Math.floor(params.startMs / 1000);
  const endSec = Math.floor(params.stopMs / 1000);
  const nowSec = Math.floor(params.nowMs / 1000);
  const durationSec = Math.max(1, Math.round((params.stopMs - params.startMs) / 1000));
  const offsetSec = Math.max(0, nowSec - startSec);
  let calendar: CalendarParts | undefined;
  const parts = (): CalendarParts => {
    if (calendar === undefined) {
      calendar = extractCalendarParts(params.startMs, params.serverTimezone);
    }
    return calendar;
  };

  return template.replace(
    TEMPLATE_TOKEN_RE,
    (token, dollarKey: string | undefined, braceKey: string | undefined) => {
      switch (dollarKey ?? braceKey) {
        case 'utc':
        case 'start':
        case 'timestamp':
          return String(startSec);
        case 'end':
        case 'utcend':
          return String(endSec);
        case 'duration':
          return String(durationSec);
        case 'offset':
          return String(offsetSec);
        case 'lutc':
          return String(nowSec);
        case 'Y':
          return parts().year;
        case 'm':
          return parts().month;
        case 'd':
          return parts().day;
        case 'H':
          return parts().hour;
        case 'M':
          return parts().minute;
        case 'S':
          return parts().second;
        default:
          return token;
      }
    },
  );
}

/** Builds and validates a play-time catch-up URL across Xtream, Stalker, and M3U modes. */
export function buildCatchupUrl(input: BuildCatchupUrlInput): Result<string> {
  const window = isProgrammeWithinCatchupWindow(input.programme, input.catchupDays, input.nowMs);
  if (!window.ok) {
    return err(elvError('playback', window.reason));
  }

  const { startMs, stopMs } = input.programme;
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(stopMs / 1000);
  const durationSec = Math.max(1, Math.round((stopMs - startMs) / 1000));
  const invalid = () => err(elvError('source-format', 'invalid-catchup-url'));

  let url: string | null = null;

  if (input.mode === 'xc') {
    const cleanServer = normalizeXcCatchupServer(input.server);
    const streamIdStr = String(input.streamId).trim();
    const ext = input.ext?.trim().replace(/^\.+/, '') || 'ts';
    if (
      cleanServer === null ||
      streamIdStr === '' ||
      ext.includes('/') ||
      ext.includes('?') ||
      ext.includes('#')
    ) {
      return invalid();
    }
    const durationMin = Math.max(1, Math.ceil((stopMs - startMs) / 60_000));
    const startFormatted = formatXtreamTimeshiftStart(startMs, input.serverTimezone);
    const encUser = encodeURIComponent(input.username);
    const encPass = encodeURIComponent(input.password);
    const encStream = encodeURIComponent(streamIdStr);
    const encExt = encodeURIComponent(ext);
    url =
      input.xcScheme === 'legacy'
        ? `${cleanServer}/streaming/timeshift.php?username=${encUser}&password=${encPass}&stream=${encStream}&start=${startFormatted}&duration=${durationMin}&extension=${encExt}`
        : `${cleanServer}/timeshift/${encUser}/${encPass}/${durationMin}/${startFormatted}/${encStream}.${encExt}`;
  } else {
    const liveUrl = input.liveUrl.trim();
    const templateParams: CatchupTemplateParams = {
      startMs,
      stopMs,
      nowMs: input.nowMs,
      ...(input.serverTimezone !== undefined ? { serverTimezone: input.serverTimezone } : {}),
    };
    const source = input.catchupSource?.trim() ?? '';

    switch (input.mode) {
      case 'stalker':
      case 'shift':
        url = appendQueryParams(liveUrl, `utc=${startSec}&lutc=${endSec}`);
        break;
      case 'flussonic':
        url = buildFlussonicUrl(liveUrl, startSec, durationSec);
        break;
      case 'append':
        if (source === '') return invalid();
        url = joinAppendUrl(liveUrl, expandCatchupTemplate(source, templateParams));
        break;
      case 'default':
        url =
          source !== ''
            ? expandCatchupTemplate(source, templateParams)
            : appendQueryParams(liveUrl, `utc=${startSec}&lutc=${endSec}`);
        break;
    }
  }

  if (url === null || !isValidHttpCatchupUrl(url)) {
    return invalid();
  }
  return ok(url);
}

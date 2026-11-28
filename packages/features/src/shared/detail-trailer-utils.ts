import type { FormFactor } from '@elv/ui-kit';

const STRICT_YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Resolved cross-platform trailer playback strategy (`#512`). */
export type TrailerPlaybackStrategy =
  | { readonly kind: 'native-stream'; readonly url: string }
  | { readonly kind: 'external-youtube'; readonly youtubeId: string; readonly watchUrl: string }
  | {
      readonly kind: 'web-iframe';
      readonly youtubeId: string;
      readonly embedUrl: string;
      readonly watchUrl: string;
    }
  | { readonly kind: 'mobile-external'; readonly youtubeId: string; readonly watchUrl: string }
  | { readonly kind: 'unavailable' };

/** Validates a strict 11-character YouTube video identifier (`/^[A-Za-z0-9_-]{11}$/`). */
export function isValidYoutubeId(id: string | null | undefined): id is string {
  if (typeof id !== 'string') return false;
  return STRICT_YOUTUBE_ID_RE.test(id.trim());
}

function hasControlOrWhitespace(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return /\s/.test(raw);
}

function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const val = Number.parseInt(part.slice(2), 16);
    return Number.isSafeInteger(val) && val >= 0 && val <= 0xffffffff ? val : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const val = Number.parseInt(part, 8);
    return Number.isSafeInteger(val) && val >= 0 && val <= 0xffffffff ? val : null;
  }
  if (/^(?:0|[1-9][0-9]*)$/.test(part)) {
    const val = Number.parseInt(part, 10);
    return Number.isSafeInteger(val) && val >= 0 && val <= 0xffffffff ? val : null;
  }
  return null;
}

function parseIpv4Octets(host: string): readonly [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const parsed = parseIpv4Part(part);
    if (parsed === null) return null;
    nums.push(parsed);
  }
  const last = nums[nums.length - 1];
  if (last === undefined) return null;
  for (let i = 0; i < nums.length - 1; i += 1) {
    if ((nums[i] ?? 256) > 255) return null;
  }
  const maxLast = 256 ** (5 - nums.length) - 1;
  if (last > maxLast) return null;
  let value = last;
  for (let i = 0; i < nums.length - 1; i += 1) {
    value += (nums[i] ?? 0) * 256 ** (3 - i);
  }
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function isBlockedIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseIpv6Groups(rawInner: string): readonly number[] | null {
  const zoneIdx = rawInner.indexOf('%');
  const inner = zoneIdx >= 0 ? rawInner.slice(0, zoneIdx) : rawInner;
  if (inner.length === 0) return null;

  const doubleColonParts = inner.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string, allowTrailingIpv4: boolean): number[] | null => {
    if (side.length === 0) return [];
    const tokens = side.split(':');
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i] ?? '';
      if (allowTrailingIpv4 && i === tokens.length - 1 && tok.includes('.')) {
        const ipv4 = parseIpv4Octets(tok);
        if (ipv4 === null) return null;
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(tok)) {
        groups.push(Number.parseInt(tok, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSide(doubleColonParts[0] ?? '', true);
    return groups !== null && groups.length === 8 ? groups : null;
  }

  const left = parseSide(doubleColonParts[0] ?? '', false);
  const right = parseSide(doubleColonParts[1] ?? '', true);
  if (left === null || right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(rawInner: string): boolean {
  const groups = parseIpv6Groups(rawInner);
  if (groups === null) return true;
  const g0 = groups[0] ?? 0;
  // Unspecified (::), loopback (::1), and deprecated IPv4-compatible (::/96)
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return true;
  }
  // Link-local fe80::/10 (fe80..febf)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // Unique local fc00::/7 (fc00..fdff)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  return false;
}

/**
 * Validates a direct public HTTPS trailer stream URL, rejecting control characters, whitespace,
 * credentials, non-HTTPS schemes, and loopback/private/link-local SSRF hosts (`#512`).
 */
export function isValidTrailerStreamUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string' || url.length === 0 || hasControlOrWhitespace(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    const rawHost = parsed.hostname.toLowerCase();
    if (rawHost.length === 0) return false;
    if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
      return !isBlockedIpv6(rawHost.slice(1, -1));
    }
    const host = rawHost.replace(/\.+$/, '');
    if (host.length === 0) return false;
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    const ipv4 = parseIpv4Octets(host);
    if (ipv4 !== null && isBlockedIpv4(ipv4)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Builds a strict `https://www.youtube.com/watch?v=...` URL from a validated 11-char YouTube ID. */
export function buildYoutubeWatchUrl(youtubeId: string | null | undefined): string | null {
  if (!isValidYoutubeId(youtubeId)) return null;
  return `https://www.youtube.com/watch?v=${youtubeId.trim()}`;
}

/** Builds a strict privacy-enhanced `youtube-nocookie.com` embed URL from a validated 11-char YouTube ID. */
export function buildYoutubeEmbedUrl(youtubeId: string | null | undefined): string | null {
  if (!isValidYoutubeId(youtubeId)) return null;
  return `https://www.youtube-nocookie.com/embed/${youtubeId.trim()}?autoplay=1&rel=0`;
}

/**
 * Selects the optimal cross-platform trailer playback strategy (`#512`):
 * 1. Direct IMDb MP4/HLS HTTPS stream inside our native `VideoHost` player (all platforms incl. tvOS).
 * 2. Strict 11-char YouTube ID -> TV external handoff, Desktop/Web sandboxed `youtube-nocookie` iframe,
 *    or Mobile external handoff (zero broken WebView dependency).
 */
export function resolveTrailerPlaybackStrategy(input: {
  readonly trailerStreamUrl: string | null | undefined;
  readonly trailerYoutubeId: string | null | undefined;
  readonly formFactor: FormFactor;
  readonly platformOs: string;
  readonly hasVideoHost: boolean;
}): TrailerPlaybackStrategy {
  if (input.hasVideoHost && isValidTrailerStreamUrl(input.trailerStreamUrl)) {
    return { kind: 'native-stream', url: input.trailerStreamUrl.trim() };
  }
  if (isValidYoutubeId(input.trailerYoutubeId)) {
    const youtubeId = input.trailerYoutubeId.trim();
    const watchUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
    if (input.formFactor === 'tv') {
      return { kind: 'external-youtube', youtubeId, watchUrl };
    }
    if (input.platformOs === 'web') {
      const embedUrl = `https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`;
      return { kind: 'web-iframe', youtubeId, embedUrl, watchUrl };
    }
    return { kind: 'mobile-external', youtubeId, watchUrl };
  }
  return { kind: 'unavailable' };
}

/** Formats IMDb vote counts compactly (`850`, `12.5K`, `2.5M`), or `null` when non-positive. */
export function formatCompactVotes(votes: number | null | undefined): string | null {
  if (votes === null || votes === undefined || !Number.isFinite(votes) || votes <= 0) return null;
  const rounded = Math.round(votes);
  if (rounded >= 1_000_000) {
    const millions = Math.round((rounded / 1_000_000) * 10) / 10;
    return `${millions % 1 === 0 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (rounded >= 1_000) {
    const thousands = Math.round((rounded / 1_000) * 10) / 10;
    return `${thousands % 1 === 0 ? Math.round(thousands) : thousands.toFixed(1)}K`;
  }
  return String(rounded);
}

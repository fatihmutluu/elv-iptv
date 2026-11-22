import type { M3uEntry } from '@elv/sources';
import type { RuleBook } from './m3u-rules';
import type { VarBook } from './m3u-templating';
import { hostOf, type SegmentRule, toTemplate } from './templates';

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
]);

export interface TemplatingScope {
  readonly rules: { readonly rules: readonly SegmentRule[] };
  readonly known: { username?: string; password?: string };
  readonly book: VarBook;
}

/** Collects stream, backup stream, logo, referer, and URL-valued header roles from sample M3U entries. */
export function collectSampleUrls(sample: readonly M3uEntry[]): { url: string; role: string }[] {
  const out: { url: string; role: string }[] = [];
  for (const e of sample) {
    out.push({ url: e.url, role: 'stream' });
    if (e.backupUrls !== undefined) {
      for (const backup of e.backupUrls) out.push({ url: backup, role: 'stream' });
    }
    if (e.tvgLogo !== undefined) out.push({ url: e.tvgLogo, role: 'logo' });
    if (e.headers.referer !== undefined) out.push({ url: e.headers.referer, role: 'referer' });
    for (const v of Object.values(e.headers.other)) {
      if (hostOf(v) !== undefined) out.push({ url: v, role: 'other' });
    }
  }
  return out;
}

/** Returns `true` when any host referenced by `entry` is still collecting sample URLs. */
export function holdEntry(rules: RuleBook, entry: M3uEntry): boolean {
  let wait = rules.hold(entry.url, 'stream');
  if (entry.backupUrls !== undefined) {
    for (const backup of entry.backupUrls) {
      if (rules.hold(backup, 'stream')) wait = true;
    }
  }
  if (entry.tvgLogo !== undefined && rules.hold(entry.tvgLogo, 'logo')) wait = true;
  if (entry.headers.referer !== undefined && rules.hold(entry.headers.referer, 'referer')) {
    wait = true;
  }
  for (const v of Object.values(entry.headers.other)) {
    if (hostOf(v) !== undefined && rules.hold(v, 'other')) wait = true;
  }
  return wait;
}

/** Converts a URL to its credential-free template and absorbs extracted secret vars into `st.book`. */
export function templated(st: TemplatingScope, url: string): string {
  return st.book.absorb(toTemplate(url, st.rules.rules, st.known));
}

/** Serializes an entry's custom headers into credential-free `headers_json` (templating UA/auth/URL headers). */
export function entryHeaders(st: TemplatingScope, entry: M3uEntry): string | null {
  const headers: { userAgent?: string; referer?: string; other?: Record<string, string> } = {};
  if (entry.headers.userAgent !== undefined) {
    headers.userAgent = st.book.absorb({
      template: '{{h:user-agent}}',
      vars: { 'h:user-agent': entry.headers.userAgent },
    });
  }
  if (entry.headers.referer !== undefined) headers.referer = templated(st, entry.headers.referer);
  const otherKeys = Object.keys(entry.headers.other);
  if (otherKeys.length > 0) {
    const other: Record<string, string> = {};
    for (const key of otherKeys) {
      const val = entry.headers.other[key] as string;
      if (SECRET_HEADERS.has(key)) {
        const name = `h:${key}`;
        other[key] = st.book.absorb({ template: `{{${name}}}`, vars: { [name]: val } });
      } else if (hostOf(val) !== undefined) {
        other[key] = templated(st, val);
      } else {
        other[key] = val.replace(/\{\{/g, '{{(}}');
      }
    }
    headers.other = other;
  }
  return Object.keys(headers).length === 0 ? null : JSON.stringify(headers);
}

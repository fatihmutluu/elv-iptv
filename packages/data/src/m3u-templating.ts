import type { UrlVars } from './templates';
import { MAX_URLVARS_TOTAL_BYTES } from './urlvars-store';

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const PLAYLIST_URL = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(?:\/[^?#]*)?(?:\?([^#]*))?/i;
const TILDE_SUFFIX = /^(.+)~(\d+)$/;
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const utf8 = new TextEncoder();

/** Entries of the first rule judgement, and the most entries held back while a later host is judged. */
export const SAMPLE_SIZE = 1000;

/** Maximum serialized UTF-8 byte ceiling of `urlvars` per M3U source across shards (~15 MiB). */
export const MAX_URLVARS_BYTES = MAX_URLVARS_TOTAL_BYTES;

function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

/**
 * Collects the values behind the placeholders of many templates in O(1) per lookup. A value that clashes with an
 * earlier one under the same name gets a `~<n>` suffix (and the template is rewritten), so no value is lost.
 * Tracks exact UTF-8 byte length of `JSON.stringify(vars)`.
 */
export class VarBook {
  readonly vars: UrlVars = Object.create(null) as UrlVars;
  private readonly byBase = new Map<string, Map<string, string>>();
  private readonly nextIndex = new Map<string, number>();
  private count = 0;
  private bytes = 2;

  constructor(seed: UrlVars = {}) {
    for (const [key, value] of Object.entries(seed)) {
      if (PROTO_KEYS.has(key) || typeof value !== 'string') continue;
      this.insert(key, value);
      this.remember(key, value, key);
      const m = TILDE_SUFFIX.exec(key);
      if (m !== null) {
        const base = m[1] as string;
        const num = Number(m[2]);
        this.remember(base, value, key);
        this.nextIndex.set(base, Math.max(this.nextIndex.get(base) ?? 1, num + 1));
      }
    }
  }

  /** Current UTF-8 byte length of `JSON.stringify(this.vars)`. */
  get byteLength(): number {
    return this.bytes;
  }

  /** Records the values of one templated URL and returns its template with clashing names renamed. */
  absorb(t: { template: string; vars: UrlVars }): string {
    const renames = new Map<string, string>();
    for (const [name, value] of Object.entries(t.vars)) {
      if (PROTO_KEYS.has(name) || typeof value !== 'string') continue;
      let valMap = this.byBase.get(name);
      if (valMap === undefined) {
        valMap = new Map();
        this.byBase.set(name, valMap);
      }
      let target = valMap.get(value);
      if (target === undefined) {
        if (!Object.hasOwn(this.vars, name)) {
          target = name;
        } else {
          let k = this.nextIndex.get(name) ?? 1;
          while (Object.hasOwn(this.vars, `${name}~${k}`) && this.vars[`${name}~${k}`] !== value) {
            k += 1;
          }
          target = `${name}~${k}`;
          this.nextIndex.set(name, k + 1);
        }
        valMap.set(value, target);
        if (!Object.hasOwn(this.vars, target)) this.insert(target, value);
      }
      if (target !== name) renames.set(name, target);
    }
    if (renames.size === 0) return t.template;
    return t.template.replace(PLACEHOLDER, (whole, name: string) => {
      const target = renames.get(name);
      return target === undefined ? whole : `{{${target}}}`;
    });
  }

  private remember(base: string, value: string, target: string): void {
    let valMap = this.byBase.get(base);
    if (valMap === undefined) {
      valMap = new Map();
      this.byBase.set(base, valMap);
    }
    if (!valMap.has(value)) valMap.set(value, target);
  }

  private insert(key: string, value: string): void {
    if (PROTO_KEYS.has(key)) return;
    this.vars[key] = value;
    const entryBytes =
      utf8ByteLength(JSON.stringify(key)) + 1 + utf8ByteLength(JSON.stringify(value));
    this.bytes += (this.count === 0 ? 0 : 1) + entryBytes;
    this.count += 1;
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Extracts credentials from a playlist URL: `userinfo` (`user:pass@host`) and `username`/`user` +
 * `password`/`pass`/`pwd` query parameters on any playlist path.
 */
export function knownCredentials(playlistUrl: string): { username?: string; password?: string } {
  const known: { username?: string; password?: string } = {};
  const m = PLAYLIST_URL.exec(playlistUrl);
  if (m === null) return known;
  const authority = m[1] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    const rawUser = colon < 0 ? userinfo : userinfo.slice(0, colon);
    const rawPass = colon < 0 ? '' : userinfo.slice(colon + 1);
    const u = decode(rawUser);
    const p = decode(rawPass);
    if (u !== '') known.username = u;
    if (p !== '') known.password = p;
  }
  const query = m[2];
  if (query === undefined) return known;
  let explicitUser = false;
  let explicitPass = false;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).toLowerCase();
    const val = decode(pair.slice(eq + 1));
    if (val === '') continue;
    if (name === 'username') {
      known.username = val;
      explicitUser = true;
    } else if (name === 'user' && !explicitUser) {
      known.username = val;
    } else if (name === 'password') {
      known.password = val;
      explicitPass = true;
    } else if ((name === 'pass' || name === 'pwd') && !explicitPass) {
      known.password = val;
    }
  }
  return known;
}

/** Names of the placeholders in a template. */
export function placeholderNames(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

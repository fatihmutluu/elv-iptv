import type { SegmentRule, UrlVars } from './templates';

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const URL_HEAD = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i;
const GET_PHP = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(?:\/[^/?#]*)*\/get\.php\?([^#]*)/i;

/** Sample size for rule detection and for the majority value of each rule. */
export const SAMPLE_SIZE = 1000;

/**
 * Collects the values behind the placeholders of many templates. A value that clashes with an earlier one under
 * the same name gets a `~<n>` suffix (and the template is rewritten), so no value is lost.
 */
export class VarBook {
  readonly vars: UrlVars;

  constructor(seed: UrlVars = {}) {
    this.vars = { ...seed };
  }

  /** Records the values of one templated URL and returns its template with clashing names renamed. */
  absorb(t: { template: string; vars: UrlVars }): string {
    const renames = new Map<string, string>();
    for (const [name, value] of Object.entries(t.vars)) {
      let target = name;
      for (let k = 1; Object.hasOwn(this.vars, target) && this.vars[target] !== value; k += 1) {
        target = `${name}~${k}`;
      }
      this.vars[target] = value;
      if (target !== name) renames.set(name, target);
    }
    if (renames.size === 0) return t.template;
    return t.template.replace(PLACEHOLDER, (whole, name: string) => {
      const target = renames.get(name);
      return target === undefined ? whole : `{{${target}}}`;
    });
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** The `username` and `password` of an Xtream `get.php` playlist URL; empty for any other URL. */
export function knownCredentials(playlistUrl: string): { username?: string; password?: string } {
  const known: { username?: string; password?: string } = {};
  const query = GET_PHP.exec(playlistUrl)?.[1];
  if (query === undefined) return known;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).toLowerCase();
    if (name === 'username') known.username = decode(pair.slice(eq + 1));
    if (name === 'password') known.password = decode(pair.slice(eq + 1));
  }
  return known;
}

/** The most frequent value of each rule's path position in the sample (rules without a hit are left out). */
export function majorityValues(rules: readonly SegmentRule[], sample: readonly string[]): UrlVars {
  const parsed: { host: string; segments: string[] }[] = [];
  for (const url of sample) {
    const m = URL_HEAD.exec(url);
    if (m === null) continue;
    const authority = m[1] ?? '';
    parsed.push({
      host: authority.slice(authority.lastIndexOf('@') + 1).toLowerCase(),
      segments: (m[2] ?? '') === '' ? [] : (m[2] ?? '').slice(1).split('/'),
    });
  }
  const result: UrlVars = {};
  for (const rule of rules) {
    const counts = new Map<string, number>();
    for (const p of parsed) {
      const value = p.segments[rule.position];
      if (p.host !== rule.host || value === undefined || value === '') continue;
      if (rule.position >= p.segments.length - 1) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [value, n] of counts) {
      if (n > bestCount) {
        best = value;
        bestCount = n;
      }
    }
    if (best !== undefined) result[rule.name] = best;
  }
  return result;
}

/** Names of the placeholders in a template. */
export function placeholderNames(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

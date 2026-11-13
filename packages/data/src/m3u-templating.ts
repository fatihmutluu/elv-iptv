import type { UrlVars } from './templates';

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const GET_PHP = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(?:\/[^/?#]*)*\/get\.php\?([^#]*)/i;

/** Entries of the first rule judgement, and the most entries held back while a later host is judged. */
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

/** Names of the placeholders in a template. */
export function placeholderNames(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

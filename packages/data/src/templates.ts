import { CREDENTIAL_PARAMS } from '@elv/domain';

/** A path position whose value is a per-source secret on one host. `name` is the placeholder, like `v0`. */
export interface SegmentRule {
  host: string;
  position: number;
  name: string;
}

/** Values behind the placeholders of a template, keyed by placeholder name. */
export interface UrlVars {
  [name: string]: string;
}

const URL_SPLIT = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const NUMERIC_ID = /^\d+(?:\.[a-z0-9]+)?$/i;
const MIN_SEGMENT_LENGTH = 8;
const MIN_SHARE = 0.99;
const MIN_URLS = 2;

interface Parts {
  scheme: string;
  userinfo: string | undefined;
  host: string;
  segments: string[];
  query: string | undefined;
  fragment: string;
}

function parse(url: string): Parts | undefined {
  const m = URL_SPLIT.exec(url);
  if (m === null) return undefined;
  const authority = m[2] ?? '';
  const at = authority.lastIndexOf('@');
  const path = m[3] ?? '';
  return {
    scheme: m[1] ?? '',
    userinfo: at < 0 ? undefined : authority.slice(0, at),
    host: authority.slice(at + 1),
    segments: path === '' ? [] : path.slice(1).split('/'),
    query: m[4]?.slice(1),
    fragment: m[5] ?? '',
  };
}

/**
 * Detects per-source constant path segments: a position whose value is identical for at least 99 % of the
 * sampled URLs of a host and is at least 8 characters long. The last segment is the resource itself and is
 * never a candidate; a host needs at least two sampled URLs. Rules are named `v0`, `v1`, ... in order of
 * first appearance.
 */
export function detectSegmentRules(sample: readonly string[]): SegmentRule[] {
  const hosts = new Map<string, string[][]>();
  for (const url of sample) {
    const p = parse(url);
    if (p === undefined) continue;
    const key = p.host.toLowerCase();
    const list = hosts.get(key) ?? [];
    list.push(p.segments);
    hosts.set(key, list);
  }
  const rules: SegmentRule[] = [];
  for (const [host, urls] of hosts) {
    if (urls.length < MIN_URLS) continue;
    const width = Math.max(...urls.map((s) => s.length - 1), 0);
    for (let position = 0; position < width; position += 1) {
      const counts = new Map<string, number>();
      for (const segs of urls) {
        const value = position < segs.length - 1 ? (segs[position] as string) : undefined;
        if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      for (const [value, n] of counts) {
        if (value.length >= MIN_SEGMENT_LENGTH && n / urls.length >= MIN_SHARE) {
          rules.push({ host, position, name: `v${rules.length}` });
        }
      }
    }
  }
  return rules;
}

function xtreamCredentialIndexes(segs: readonly string[]): [number, number] | undefined {
  const first = (segs[0] ?? '').toLowerCase();
  if (
    segs.length === 4 &&
    /^(live|movie|series)$/.test(first) &&
    NUMERIC_ID.test(segs[3] as string)
  ) {
    return [1, 2];
  }
  if (segs.length >= 4 && first === 'timeshift') return [1, 2];
  if (segs.length === 3 && NUMERIC_ID.test(segs[2] as string)) return [0, 1];
  return undefined;
}

function templateQuery(query: string, vars: UrlVars): string {
  const seen = new Map<string, number>();
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      const lower = name.toLowerCase();
      if (!CREDENTIAL_PARAMS.has(lower)) return pair;
      const n = (seen.get(lower) ?? 0) + 1;
      seen.set(lower, n);
      const varName = n === 1 ? `q:${lower}` : `q:${lower}:${n}`;
      vars[varName] = pair.slice(eq + 1);
      return `${name}={{${varName}}}`;
    })
    .join('&');
}

/**
 * Replaces everything secret in a URL with `{{name}}` placeholders and returns the values. Placeholders:
 * `userinfo`, `user` and `pass` (Xtream path segments or segments equal to the known credentials), `v<N>`
 * (segment rules of the URL's host) and `q:<param>` (credential query parameters, ADR 0011 list).
 * {@link resolveTemplate} reverses it exactly. An unparsable value is returned unchanged.
 */
export function toTemplate(
  url: string,
  rules: readonly SegmentRule[],
  known: { username?: string; password?: string },
): { template: string; vars: UrlVars } {
  const p = parse(url);
  const vars: UrlVars = {};
  if (p === undefined) return { template: url, vars };
  const segs = [...p.segments];
  const done = new Set<number>();
  const put = (index: number, name: string): void => {
    vars[name] = segs[index] as string;
    segs[index] = `{{${name}}}`;
    done.add(index);
  };
  const host = p.host.toLowerCase();
  for (const rule of rules) {
    if (rule.host === host && segs[rule.position] !== undefined && segs[rule.position] !== '') {
      put(rule.position, rule.name);
    }
  }
  const xt = xtreamCredentialIndexes(p.segments);
  if (xt !== undefined && !done.has(xt[0]) && !done.has(xt[1])) {
    put(xt[0], 'user');
    put(xt[1], 'pass');
  }
  segs.forEach((seg, i) => {
    if (done.has(i) || seg === '') return;
    if (vars.user === undefined && seg === known.username) put(i, 'user');
    else if (vars.pass === undefined && seg === known.password) put(i, 'pass');
  });
  let authority = p.host;
  if (p.userinfo !== undefined) {
    vars.userinfo = p.userinfo;
    authority = `{{userinfo}}@${p.host}`;
  }
  const path = p.segments.length === 0 ? '' : `/${segs.join('/')}`;
  const query = p.query === undefined ? '' : `?${templateQuery(p.query, vars)}`;
  return { template: `${p.scheme}${authority}${path}${query}${p.fragment}`, vars };
}

/** Puts the values back into a template; placeholders without a value stay as they are. */
export function resolveTemplate(template: string, vars: UrlVars): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(vars, name) ? (vars[name] as string) : whole,
  );
}

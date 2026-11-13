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

const MIN_KNOWN_LENGTH = 3;
const ESCAPE_NAME = '(';

const escapeLiteral = (text: string): string => text.replace(/\{\{/g, `{{${ESCAPE_NAME}}}`);
const regexEscape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function assign(vars: UrlVars, base: string, text: string): string {
  for (let k = 0; ; k += 1) {
    const name = k === 0 ? base : `${base}:${k}`;
    if (!Object.hasOwn(vars, name)) {
      vars[name] = text;
      return name;
    }
    if (vars[name] === text) return name;
  }
}

function encodings(value: string): string[] {
  try {
    const enc = encodeURIComponent(value);
    const full = enc.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const lower = (s: string): string => s.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
    const plus = (s: string): string => s.replace(/%20/g, '+');
    return [value, enc, full, lower(enc), lower(full), plus(enc), plus(full)];
  } catch {
    return [value];
  }
}

function decodedForms(text: string): string[] {
  const forms = [text];
  for (const candidate of [text, text.replace(/\+/g, ' ')]) {
    try {
      forms.push(decodeURIComponent(candidate));
    } catch {
      // not valid percent-encoding: only the raw form applies
    }
  }
  return forms;
}

interface Masker {
  /** Escapes literal text and swaps embedded known credentials for placeholders. */
  literal(text: string): string;
  /** Placeholder base (`user` or `pass`) when the whole text decodes to a known credential. */
  whole(text: string): 'user' | 'pass' | undefined;
}

function makeMasker(known: { username?: string; password?: string }, vars: UrlVars): Masker {
  const entries: { base: 'user' | 'pass'; value: string }[] = [];
  if ((known.username ?? '').length >= MIN_KNOWN_LENGTH) {
    entries.push({ base: 'user', value: known.username as string });
  }
  if ((known.password ?? '').length >= MIN_KNOWN_LENGTH) {
    entries.push({ base: 'pass', value: known.password as string });
  }
  const lookup = new Map<string, 'user' | 'pass'>();
  for (const e of entries) {
    for (const form of encodings(e.value)) if (!lookup.has(form)) lookup.set(form, e.base);
  }
  const forms = [...lookup.keys()].sort((a, b) => b.length - a.length);
  const pattern =
    forms.length === 0 ? undefined : new RegExp(forms.map(regexEscape).join('|'), 'g');
  return {
    literal(text) {
      if (pattern === undefined) return escapeLiteral(text);
      let out = '';
      let last = 0;
      for (const m of text.matchAll(pattern)) {
        const base = lookup.get(m[0]) as 'user' | 'pass';
        out += escapeLiteral(text.slice(last, m.index));
        out += `{{${assign(vars, base, m[0])}}}`;
        last = m.index + m[0].length;
      }
      return out + escapeLiteral(text.slice(last));
    },
    whole(text) {
      const decoded = decodedForms(text);
      return entries.find((e) => decoded.includes(e.value))?.base;
    },
  };
}

function templateQuery(query: string, vars: UrlVars, mask: Masker): string {
  const seen = new Map<string, number>();
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return mask.literal(pair);
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const lower = name.toLowerCase();
      if (CREDENTIAL_PARAMS.has(lower)) {
        const n = (seen.get(lower) ?? 0) + 1;
        seen.set(lower, n);
        const varName = n === 1 ? `q:${lower}` : `q:${lower}:${n}`;
        vars[varName] = value;
        return `${escapeLiteral(name)}={{${varName}}}`;
      }
      const base = mask.whole(value);
      if (base !== undefined) return `${mask.literal(name)}={{${assign(vars, base, value)}}}`;
      return mask.literal(pair);
    })
    .join('&');
}

/**
 * Replaces everything secret in a URL with `{{name}}` placeholders and returns the values. Placeholders:
 * `userinfo`; `user` and `pass` (Xtream-shaped path segments, and the known credentials wherever they occur
 * raw or percent-encoded, with `:<n>` suffixes when one credential appears in several spellings); `v<N>`
 * (segment rules of the URL's host); `q:<param>` (credential query parameters, ADR 0011 list). Literal `{{`
 * becomes `{{(}}`. {@link resolveTemplate} reverses it exactly. An unparsable value is returned unchanged.
 *
 * Segment rules and whole-segment credential matches never touch the last path segment (the resource itself).
 * Known credentials shorter than 3 characters are only replaced inside Xtream-shaped paths, so a one-character
 * password cannot rewrite unrelated text. When `expected` holds a rule's value, only a segment equal to it is
 * templated; any other value stays literal.
 */
export function toTemplate(
  url: string,
  rules: readonly SegmentRule[],
  known: { username?: string; password?: string },
  expected?: UrlVars,
): { template: string; vars: UrlVars } {
  const p = parse(url);
  const vars: UrlVars = {};
  if (p === undefined) return { template: url, vars };
  const mask = makeMasker(known, vars);
  const segs = p.segments;
  const last = segs.length - 1;
  const names: (string | undefined)[] = new Array(segs.length).fill(undefined);
  const host = p.host.toLowerCase();
  for (const rule of rules) {
    const seg = segs[rule.position];
    if (rule.host !== host || rule.position >= last || seg === undefined || seg === '') continue;
    if (names[rule.position] !== undefined) continue;
    if (
      expected !== undefined &&
      Object.hasOwn(expected, rule.name) &&
      expected[rule.name] !== seg
    ) {
      continue;
    }
    vars[rule.name] = seg;
    names[rule.position] = rule.name;
  }
  const xt = xtreamCredentialIndexes(segs);
  if (xt !== undefined && names[xt[0]] === undefined && names[xt[1]] === undefined) {
    names[xt[0]] = assign(vars, 'user', segs[xt[0]] as string);
    names[xt[1]] = assign(vars, 'pass', segs[xt[1]] as string);
  }
  for (let i = 0; i < last; i += 1) {
    const seg = segs[i] as string;
    const base = names[i] === undefined && seg !== '' ? mask.whole(seg) : undefined;
    if (base !== undefined) names[i] = assign(vars, base, seg);
  }
  let path = '';
  let run = '';
  segs.forEach((seg, i) => {
    run += '/';
    const name = names[i];
    if (name === undefined) {
      run += seg;
      return;
    }
    path += `${mask.literal(run)}{{${name}}}`;
    run = '';
  });
  path += mask.literal(run);
  let authority = escapeLiteral(p.host);
  if (p.userinfo !== undefined) {
    vars.userinfo = p.userinfo;
    authority = `{{userinfo}}@${authority}`;
  }
  const query = p.query === undefined ? '' : `?${templateQuery(p.query, vars, mask)}`;
  const template = `${escapeLiteral(p.scheme)}${authority}${path}${query}${mask.literal(p.fragment)}`;
  return { template, vars };
}

/** Puts the values back into a template and unescapes literal braces; unknown placeholders stay as they are. */
export function resolveTemplate(template: string, vars: UrlVars): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === ESCAPE_NAME) return '{{';
    return Object.hasOwn(vars, name) ? (vars[name] as string) : whole;
  });
}

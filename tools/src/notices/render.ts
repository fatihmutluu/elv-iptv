/** Single third-party software notice entry bundled offline into the apps. */
export interface ThirdPartyNotice {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly platforms: readonly string[];
  readonly sourceUrl: string;
  readonly modificationNote?: string;
  readonly noticeText: string;
}

const BANNED_PATTERNS: readonly { readonly label: string; readonly regex: RegExp }[] = [
  {
    label: 'competitor/reference player brand',
    regex:
      /\b(?:tivimate|iptv\s*smarters|smarters|streamyfin|iptvnator|moonfin|iptv\s*deck|oriontv|xciptv|ott\s*navigator|televizo|kodi|perfect\s*player)\b/i,
  },
  {
    label: 'DVR/recording feature mention',
    regex: /\b(?:dvr|pvr|timeshift|time-shift|catch-up|catchup|record\s+live|recording)\b/i,
  },
  {
    label: 'development credential or seeder marker',
    regex: /(?<![A-Za-z0-9_])DEV_[A-Z0-9_]+|elv\.dev\.seeded|\.env\.local/,
  },
];

/** Scans generated notice source text for banned competitor/DVR/secret patterns. */
export function scanBannedCopy(text: string): string[] {
  const findings: string[] = [];
  for (const rule of BANNED_PATTERNS) {
    const match = rule.regex.exec(text);
    if (match) {
      findings.push(`forbidden ${rule.label}: "${match[0]}"`);
    }
  }
  return findings;
}

function formatTsString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  if (value.includes("'") && !value.includes('"')) {
    return `"${escaped}"`;
  }
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

function formatProp(key: string, literal: string): string {
  const singleLine = `    ${key}: ${literal},`;
  if (singleLine.length <= 100) return singleLine;
  return `    ${key}:\n      ${literal},`;
}

function formatPlatforms(platforms: readonly string[]): string {
  const items = platforms.map(formatTsString);
  const inline = `    platforms: [${items.join(', ')}],`;
  if (inline.length <= 100) return inline;
  return ['    platforms: [', ...items.map((item) => `      ${item},`), '    ],'].join('\n');
}

/** Renders `notices` as a Biome-formatted, zero-import TypeScript module (`< 400` lines). */
export function renderNoticesModule(notices: readonly ThirdPartyNotice[]): string {
  const lines: string[] = [
    '/** Deterministic third-party software notices; regenerate with `pnpm notices:sync`. */',
    'export interface ThirdPartyNotice {',
    '  readonly id: string;',
    '  readonly name: string;',
    '  readonly version: string;',
    '  readonly license: string;',
    '  readonly platforms: readonly string[];',
    '  readonly sourceUrl: string;',
    '  readonly modificationNote?: string;',
    '  readonly noticeText: string;',
    '}',
    '',
    '/** Offline third-party notices covering shipped native engines and bundled runtime packages. */',
    'export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = [',
  ];

  for (const notice of notices) {
    lines.push('  {');
    lines.push(formatProp('id', formatTsString(notice.id)));
    lines.push(formatProp('name', formatTsString(notice.name)));
    lines.push(formatProp('version', formatTsString(notice.version)));
    lines.push(formatProp('license', formatTsString(notice.license)));
    lines.push(formatPlatforms(notice.platforms));
    lines.push(formatProp('sourceUrl', formatTsString(notice.sourceUrl)));
    if (notice.modificationNote !== undefined) {
      lines.push(formatProp('modificationNote', formatTsString(notice.modificationNote)));
    }
    lines.push(formatProp('noticeText', formatTsString(notice.noticeText)));
    lines.push('  },');
  }

  lines.push('];', '');
  return lines.join('\n');
}

/** Summarizes missing or stale component entries between `actual` source and `expectedNotices`. */
export function summarizeDrift(
  actual: string,
  expectedNotices: readonly ThirdPartyNotice[],
): string[] {
  const details: string[] = [];
  for (const n of expectedNotices) {
    const idNeedle = `id: ${formatTsString(n.id)}`;
    const verNeedle = `version: ${formatTsString(n.version)}`;
    if (!actual.includes(idNeedle)) {
      details.push(`missing component ${n.name} (${n.id}@${n.version})`);
    } else if (!actual.includes(verNeedle)) {
      details.push(`version or metadata changed for ${n.name} (expected ${n.version})`);
    }
  }
  if (details.length === 0) {
    details.push('notices content differs from current lockfiles or workspace dependencies');
  }
  return details;
}

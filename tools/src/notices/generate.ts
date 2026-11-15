import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { collectNativeNotices } from './native-notices.ts';
import {
  renderNoticesModule,
  scanBannedCopy,
  summarizeDrift,
  type ThirdPartyNotice,
} from './render.ts';

export { renderNoticesModule, scanBannedCopy, type ThirdPartyNotice } from './render.ts';

/** Repo-relative path to the committed static notices module in `@elv/features`. */
export const NOTICES_OUTPUT_REL = 'packages/features/src/notices/notices-data.ts';

const CANONICAL_PLATFORMS = [
  'Android',
  'Android TV',
  'Fire OS',
  'iOS',
  'iPadOS',
  'tvOS',
  'Windows',
  'macOS',
  'Linux',
] as const;

const MOBILE_TV_PLATFORMS = ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'] as const;
const TV_ONLY_PLATFORMS = ['Android TV', 'Fire OS', 'tvOS'] as const;
const DESKTOP_PLATFORMS = ['Windows', 'macOS', 'Linux'] as const;
const ANDROID_PLATFORMS = ['Android', 'Android TV', 'Fire OS'] as const;
const APPLE_PLATFORMS = ['iOS', 'iPadOS', 'tvOS'] as const;

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string | { readonly type?: string };
  readonly homepage?: string;
  readonly repository?: string | { readonly url?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface WorkspaceSource {
  readonly dir: string;
  readonly platforms: readonly string[];
  readonly includeElectronDevDep?: boolean;
}

function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function discoverWorkspaceSources(repoRoot: string): WorkspaceSource[] {
  const sources: WorkspaceSource[] = [];
  const tvMobileDir = join(repoRoot, 'apps', 'tv-mobile');
  if (existsSync(join(tvMobileDir, 'package.json'))) {
    sources.push({ dir: tvMobileDir, platforms: MOBILE_TV_PLATFORMS });
  }
  const desktopDir = join(repoRoot, 'apps', 'desktop');
  if (existsSync(join(desktopDir, 'package.json'))) {
    sources.push({
      dir: desktopDir,
      platforms: DESKTOP_PLATFORMS,
      includeElectronDevDep: true,
    });
  }
  const rendererDir = join(repoRoot, 'apps', 'desktop', 'renderer');
  if (existsSync(join(rendererDir, 'package.json'))) {
    sources.push({ dir: rendererDir, platforms: DESKTOP_PLATFORMS });
  }

  const packagesDir = join(repoRoot, 'packages');
  if (existsSync(packagesDir)) {
    const entries = readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
      asciiCompare(a.name, b.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(packagesDir, entry.name);
      if (existsSync(join(dir, 'package.json'))) {
        sources.push({ dir, platforms: CANONICAL_PLATFORMS });
      }
    }
  }

  const modulesDir = join(repoRoot, 'modules');
  if (existsSync(modulesDir)) {
    const entries = readdirSync(modulesDir, { withFileTypes: true }).sort((a, b) =>
      asciiCompare(a.name, b.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(modulesDir, entry.name);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const hasIos = existsSync(join(dir, 'ios'));
      const hasAndroid = existsSync(join(dir, 'android'));
      const platforms =
        hasIos && !hasAndroid
          ? APPLE_PLATFORMS
          : hasAndroid && !hasIos
            ? ANDROID_PLATFORMS
            : MOBILE_TV_PLATFORMS;
      sources.push({ dir, platforms });
    }
  }
  return sources;
}

function normalizeRepoUrl(meta: PackageManifest): string {
  const rawRepo =
    typeof meta.repository === 'string' ? meta.repository : (meta.repository?.url ?? '');
  const trimmed = rawRepo.trim();
  if (trimmed !== '') {
    const withoutPrefix = trimmed
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '');
    if (/^https?:\/\//i.test(withoutPrefix)) {
      return withoutPrefix.replace(/^http:\/\/github\.com\//i, 'https://github.com/');
    }
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(withoutPrefix)) {
      return `https://github.com/${withoutPrefix}`;
    }
  }
  if (meta.homepage) return meta.homepage;
  return `https://www.npmjs.com/package/${meta.name ?? 'unknown'}`;
}

function resolveInstalledManifest(repoRoot: string, fromDir: string, depName: string): string {
  const candidates = [
    join(fromDir, 'node_modules', ...depName.split('/'), 'package.json'),
    join(repoRoot, 'node_modules', ...depName.split('/'), 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(
    `Cannot resolve installed package.json for runtime dependency "${depName}" from ${fromDir}`,
  );
}

function readPackageNoticeText(
  pkgDir: string,
  depName: string,
  license: string,
  url: string,
): string {
  const files = readdirSync(pkgDir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:\.[A-Za-z0-9]+)?$/i.test(d.name),
    )
    .map((d) => d.name)
    .sort(asciiCompare);

  const chunks: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(pkgDir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    if (content !== '') chunks.push(content);
  }

  let body =
    chunks.length > 0
      ? chunks.join('\n\n---\n\n')
      : `${depName} — Licensed under ${license}.\nSource: ${url}`;

  if (depName === '@op-engineering/op-sqlite' || depName === 'better-sqlite3') {
    body +=
      '\n\nIncludes SQLite C library (Public Domain — https://www.sqlite.org/copyright.html).';
  }
  return body;
}

function toSlugId(depName: string): string {
  return `npm-${depName
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()}`;
}

function collectNpmNotices(repoRoot: string): ThirdPartyNotice[] {
  const acc = new Map<string, { pkgJsonPath: string; platforms: Set<string> }>();

  for (const src of discoverWorkspaceSources(repoRoot)) {
    const manifest = JSON.parse(
      readFileSync(join(src.dir, 'package.json'), 'utf8'),
    ) as PackageManifest;
    const depNames = Object.keys(manifest.dependencies ?? {}).filter((k) => !k.startsWith('@elv/'));
    if (src.includeElectronDevDep && manifest.devDependencies?.electron) {
      depNames.push('electron');
    }
    depNames.sort(asciiCompare);

    for (const depName of depNames) {
      const pkgJsonPath = resolveInstalledManifest(repoRoot, src.dir, depName);
      let entry = acc.get(depName);
      if (!entry) {
        entry = { pkgJsonPath, platforms: new Set<string>() };
        acc.set(depName, entry);
      }
      const depPlatforms =
        depName === '@react-native-tvos/config-tv' ? TV_ONLY_PLATFORMS : src.platforms;
      for (const p of depPlatforms) entry.platforms.add(p);
    }
  }

  const notices: ThirdPartyNotice[] = [];
  for (const depName of [...acc.keys()].sort(asciiCompare)) {
    const info = acc.get(depName);
    if (!info) continue;
    const meta = JSON.parse(readFileSync(info.pkgJsonPath, 'utf8')) as PackageManifest;
    const actualName = meta.name ?? depName;
    const displayName = actualName !== depName ? `${depName} (${actualName})` : depName;
    const version = meta.version ?? '0.0.0';
    const rawLicense =
      typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'UNKNOWN');
    const sourceUrl = normalizeRepoUrl(meta);
    const platforms = CANONICAL_PLATFORMS.filter((p) => info.platforms.has(p));
    const noticeText = readPackageNoticeText(
      dirname(info.pkgJsonPath),
      depName,
      rawLicense,
      sourceUrl,
    );

    notices.push({
      id: toSlugId(depName),
      name: displayName,
      version,
      license: rawLicense,
      platforms,
      sourceUrl,
      noticeText,
    });
  }

  return notices.sort((a, b) => asciiCompare(a.id, b.id));
}

/** Collects deterministic native + bundled JS third-party notices for `repoRoot`. */
export function collectNotices(repoRoot: string): ThirdPartyNotice[] {
  return [...collectNativeNotices(repoRoot), ...collectNpmNotices(repoRoot)];
}

/** Writes the deterministic notices module to `outRelPath` and returns the absolute file path. */
export function writeNoticesFile(repoRoot: string, outRelPath = NOTICES_OUTPUT_REL): string {
  const notices = collectNotices(repoRoot);
  const content = renderNoticesModule(notices);
  const violations = scanBannedCopy(content);
  if (violations.length > 0) {
    throw new Error(`Refusing to write notices with forbidden copy:\n- ${violations.join('\n- ')}`);
  }
  const outPath = join(repoRoot, outRelPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, 'utf8');
  return outPath;
}

/** Verifies byte-for-byte freshness and public-copy hygiene of the committed notices file. */
export function verifyNoticesFile(
  repoRoot: string,
  outRelPath = NOTICES_OUTPUT_REL,
): { readonly ok: boolean; readonly errors: string[] } {
  const notices = collectNotices(repoRoot);
  const expected = renderNoticesModule(notices);
  const errors = scanBannedCopy(expected);

  const outPath = join(repoRoot, outRelPath);
  if (!existsSync(outPath)) {
    errors.push(`missing ${outRelPath}; run "pnpm notices:sync" to generate it`);
    return { ok: false, errors };
  }

  const actual = readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
  errors.push(...scanBannedCopy(actual));
  if (actual !== expected) {
    const drift = summarizeDrift(actual, notices);
    errors.push(
      `${outRelPath} is out of date (${drift.join('; ')}). Run "pnpm notices:sync" to update it.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

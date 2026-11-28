import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Official Electron Fuse Wire sentinel (`@electron/fuses`). */
export const ELECTRON_FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

const SENTINEL_BYTES = Buffer.from(ELECTRON_FUSE_SENTINEL, 'ascii');
const FUSE_WIRE_VERSION_V1 = 1;
const FUSE_STATE_DISABLE = 0x30; // '0'
const FUSE_STATE_ENABLE = 0x31; // '1'
const FUSE_STATE_REMOVED = 0x72; // 'r'

/** Specification of a single required ELV IPTV Electron fuse bit (`F-04`). */
interface RequiredFuseSpec {
  readonly index: number;
  readonly name: string;
  readonly expectedEnabled: boolean;
  readonly expectedWireChar: '0' | '1';
}

/** All 6 Electron fuses mandated by `apps/desktop/electron-builder.yml`. */
const REQUIRED_ELV_FUSES: readonly RequiredFuseSpec[] = [
  { index: 0, name: 'runAsNode', expectedEnabled: false, expectedWireChar: '0' },
  { index: 1, name: 'enableCookieEncryption', expectedEnabled: true, expectedWireChar: '1' },
  {
    index: 2,
    name: 'enableNodeOptionsEnvironmentVariable',
    expectedEnabled: false,
    expectedWireChar: '0',
  },
  {
    index: 3,
    name: 'enableNodeCliInspectArguments',
    expectedEnabled: false,
    expectedWireChar: '0',
  },
  {
    index: 4,
    name: 'enableEmbeddedAsarIntegrityValidation',
    expectedEnabled: true,
    expectedWireChar: '1',
  },
  { index: 5, name: 'onlyLoadAppFromAsar', expectedEnabled: true, expectedWireChar: '1' },
];

/** Result of inspecting the Electron Fuse Wire inside a packaged binary. */
export interface FuseVerificationResult {
  readonly ok: boolean;
  readonly sentinelCount: number;
  readonly fuseWireVersion: number | null;
  readonly fuseCount: number | null;
  readonly fuses: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
}

/** Result of verifying the `electronFuses` block in `electron-builder.yml`. */
export interface ConfigVerificationResult {
  readonly ok: boolean;
  readonly fuses: Readonly<Record<string, boolean>>;
  readonly errors: readonly string[];
}

/** Platform detected or forced when verifying a packaged desktop directory. */
type DesktopPackagePlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

/** Options for {@link verifyDesktopPackageDir}. */
export interface VerifyDesktopPackageOptions {
  readonly platform?: 'win32' | 'darwin' | 'linux';
  readonly requireBundledMpv?: boolean;
}

/** Complete post-pack verification report produced by {@link verifyDesktopPackageDir}. */
export interface DesktopPackageVerificationResult {
  readonly ok: boolean;
  readonly platform: DesktopPackagePlatform;
  readonly binaryPath: string | null;
  readonly resourcesDir: string | null;
  readonly fuses: FuseVerificationResult | null;
  readonly missingResources: readonly string[];
  readonly leakedArtifacts: readonly string[];
  readonly errors: readonly string[];
}

const FORBIDDEN_EXACT_NAMES = new Set([
  '.env',
  '.env.local',
  'secrets.json',
  'catalog.db',
  'catalog.db-wal',
  'catalog.db-shm',
  '.superpowers',
]);

const FORBIDDEN_EXTENSIONS = ['.map', '.pem', '.p12', '.pfx', '.key'] as const;
const FORBIDDEN_TEST_FILE_PATTERN = /\.(?:test|spec)\.[^/\\]+$/i;

function decodeFuseByte(byte: number): string | null {
  if (byte === FUSE_STATE_DISABLE) return '0';
  if (byte === FUSE_STATE_ENABLE) return '1';
  if (byte === FUSE_STATE_REMOVED) return 'r';
  return null;
}

/**
 * Inspects an Electron binary (path or raw byte buffer), locates every Electron Fuse Wire sentinel
 * (including both slices of universal macOS binaries), parses fuse wire v1, and verifies all 6
 * ELV IPTV security fuses match `apps/desktop/electron-builder.yml`.
 */
export function verifyElectronFusesInBinary(
  binaryPathOrBytes: string | Uint8Array,
): FuseVerificationResult {
  let bytes: Buffer;
  if (typeof binaryPathOrBytes === 'string') {
    if (!existsSync(binaryPathOrBytes)) {
      return {
        ok: false,
        sentinelCount: 0,
        fuseWireVersion: null,
        fuseCount: null,
        fuses: {},
        errors: [`Electron binary not found: ${binaryPathOrBytes}`],
      };
    }
    bytes = readFileSync(binaryPathOrBytes);
  } else {
    bytes = Buffer.from(
      binaryPathOrBytes.buffer,
      binaryPathOrBytes.byteOffset,
      binaryPathOrBytes.byteLength,
    );
  }

  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= bytes.byteLength - SENTINEL_BYTES.byteLength) {
    const found = bytes.indexOf(SENTINEL_BYTES, cursor);
    if (found === -1) break;
    offsets.push(found);
    cursor = found + SENTINEL_BYTES.byteLength;
  }

  if (offsets.length === 0) {
    return {
      ok: false,
      sentinelCount: 0,
      fuseWireVersion: null,
      fuseCount: null,
      fuses: {},
      errors: ['Electron fuse sentinel not found in binary'],
    };
  }

  const errors: string[] = [];
  const recordedFuses: Record<string, string> = {};
  let firstVersion: number | null = null;
  let firstCount: number | null = null;

  for (let sliceIdx = 0; sliceIdx < offsets.length; sliceIdx++) {
    const sentinelOffset = offsets[sliceIdx] as number;
    const wireStart = sentinelOffset + SENTINEL_BYTES.byteLength;
    const sliceLabel = offsets.length > 1 ? ` (slice ${sliceIdx + 1}/${offsets.length})` : '';

    if (wireStart + 2 > bytes.byteLength) {
      errors.push(`Truncated fuse wire header${sliceLabel}`);
      continue;
    }

    const versionByte = bytes[wireStart] as number;
    const fuseCount = bytes[wireStart + 1] as number;
    if (firstVersion === null) firstVersion = versionByte;
    if (firstCount === null) firstCount = fuseCount;

    if (versionByte !== FUSE_WIRE_VERSION_V1) {
      errors.push(
        `Unsupported Electron fuse wire version ${versionByte}${sliceLabel}; expected ${FUSE_WIRE_VERSION_V1}`,
      );
      continue;
    }

    if (fuseCount < REQUIRED_ELV_FUSES.length) {
      errors.push(
        `Electron fuse wire has only ${fuseCount} fuses${sliceLabel}; need at least ${REQUIRED_ELV_FUSES.length}`,
      );
      continue;
    }

    if (wireStart + 2 + fuseCount > bytes.byteLength) {
      errors.push(`Truncated Electron fuse wire states${sliceLabel}`);
      continue;
    }

    for (let i = 0; i < fuseCount; i++) {
      const rawByte = bytes[wireStart + 2 + i] as number;
      if (decodeFuseByte(rawByte) === null) {
        errors.push(`Invalid fuse byte 0x${rawByte.toString(16)} at index ${i}${sliceLabel}`);
      }
    }

    for (const spec of REQUIRED_ELV_FUSES) {
      const rawByte = bytes[wireStart + 2 + spec.index] as number;
      const decoded = decodeFuseByte(rawByte) ?? `0x${rawByte.toString(16)}`;
      if (sliceIdx === 0) recordedFuses[spec.name] = decoded;
      if (decoded !== spec.expectedWireChar) {
        errors.push(
          `Fuse ${spec.name} (index ${spec.index}) mismatch${sliceLabel}: expected '${spec.expectedWireChar}', got '${decoded}'`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    sentinelCount: offsets.length,
    fuseWireVersion: firstVersion,
    fuseCount: firstCount,
    fuses: recordedFuses,
    errors,
  };
}

/**
 * Verifies the `electronFuses:` section of `apps/desktop/electron-builder.yml` declares all 6
 * required ELV IPTV security fuses with exact expected boolean values.
 */
export function verifyElectronBuilderFusesConfig(
  configPathOrYaml: string,
  options?: { readonly isRawYaml?: boolean },
): ConfigVerificationResult {
  let yamlText: string;
  if (options?.isRawYaml === true) {
    yamlText = configPathOrYaml;
  } else {
    if (!existsSync(configPathOrYaml)) {
      return {
        ok: false,
        fuses: {},
        errors: [`electron-builder config not found: ${configPathOrYaml}`],
      };
    }
    yamlText = readFileSync(configPathOrYaml, 'utf8');
  }

  const fuses: Record<string, boolean> = {};
  const errors: string[] = [];
  let inFusesBlock = false;
  let blockIndent = -1;

  for (const rawLine of yamlText.split(/\r?\n/)) {
    const uncommented = rawLine.replace(/#.*$/, '');
    if (uncommented.trim().length === 0) continue;

    const indent = uncommented.length - uncommented.trimStart().length;
    const trimmed = uncommented.trim();

    if (!inFusesBlock) {
      if (trimmed === 'electronFuses:') {
        inFusesBlock = true;
        blockIndent = indent;
      }
      continue;
    }

    if (indent <= blockIndent) {
      break;
    }

    const kv = /^([A-Za-z0-9_]+)\s*:\s*(true|false)\s*$/.exec(trimmed);
    if (kv) {
      const key = kv[1] as string;
      const val = kv[2] === 'true';
      fuses[key] = val;
    }
  }

  if (!inFusesBlock) {
    errors.push('electronFuses block is missing from electron-builder config');
  } else {
    for (const spec of REQUIRED_ELV_FUSES) {
      if (!(spec.name in fuses)) {
        errors.push(`electronFuses is missing required key "${spec.name}"`);
      } else if (fuses[spec.name] !== spec.expectedEnabled) {
        errors.push(
          `electronFuses.${spec.name} must be ${spec.expectedEnabled}, got ${fuses[spec.name]}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, fuses, errors };
}

function collectFilesSafely(rootDir: string): {
  readonly files: string[];
  readonly dirs: string[];
} {
  const files: string[] = [];
  const dirs: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        dirs.push(full);
        stack.push(full);
      } else if (st.isFile()) {
        files.push(full);
      }
    }
  }

  return { files, dirs };
}

function isForbiddenArtifactPath(relPosix: string): boolean {
  const lower = relPosix.toLowerCase();

  const segments = lower.split('/');
  for (const seg of segments) {
    if (seg === '.superpowers') return true;
  }

  const base = basename(lower);
  if (FORBIDDEN_EXACT_NAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }
  if (FORBIDDEN_TEST_FILE_PATTERN.test(base)) return true;

  return false;
}

interface DetectedLayout {
  readonly platform: DesktopPackagePlatform;
  readonly binaryPath: string | null;
  readonly resourcesDir: string | null;
}

function resolveMacAppDir(packageDir: string): string | null {
  if (existsSync(join(packageDir, 'Contents', 'Info.plist'))) return packageDir;
  const nested = join(packageDir, 'ELV IPTV.app');
  if (existsSync(join(nested, 'Contents', 'Info.plist'))) return nested;
  try {
    for (const entry of readdirSync(packageDir)) {
      if (entry.endsWith('.app') && existsSync(join(packageDir, entry, 'Contents', 'Info.plist'))) {
        return join(packageDir, entry);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function detectPackageLayout(
  packageDir: string,
  forcedPlatform?: 'win32' | 'darwin' | 'linux',
): DetectedLayout {
  const macApp =
    forcedPlatform === undefined || forcedPlatform === 'darwin'
      ? resolveMacAppDir(packageDir)
      : null;
  if (macApp !== null) {
    const candidates = [
      join(macApp, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
      join(
        macApp,
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Electron Framework',
      ),
      join(macApp, 'Contents', 'MacOS', 'ELV IPTV'),
    ];
    const binaryPath = candidates.find((p) => existsSync(p)) ?? null;
    return {
      platform: 'darwin',
      binaryPath,
      resourcesDir: join(macApp, 'Contents', 'Resources'),
    };
  }

  const winBinary = join(packageDir, 'ELV IPTV.exe');
  if (forcedPlatform === 'win32' || (forcedPlatform === undefined && existsSync(winBinary))) {
    return {
      platform: 'win32',
      binaryPath: existsSync(winBinary) ? winBinary : null,
      resourcesDir: join(packageDir, 'resources'),
    };
  }

  const linuxCandidates = [join(packageDir, 'elv-iptv'), join(packageDir, 'ELV IPTV')];
  const linuxBinary = linuxCandidates.find((p) => existsSync(p)) ?? null;
  if (forcedPlatform === 'linux' || linuxBinary !== null) {
    return {
      platform: 'linux',
      binaryPath: linuxBinary,
      resourcesDir: join(packageDir, 'resources'),
    };
  }

  return {
    platform: 'unknown',
    binaryPath: null,
    resourcesDir: existsSync(join(packageDir, 'resources')) ? join(packageDir, 'resources') : null,
  };
}

function checkPlatformMpvResources(
  resourcesDir: string,
  platform: DesktopPackagePlatform,
  missing: string[],
): void {
  const mpvDir = join(resourcesDir, 'mpv');
  if (!existsSync(mpvDir) || !statSync(mpvDir).isDirectory()) {
    missing.push('resources/mpv/');
    return;
  }

  const { files } = collectFilesSafely(mpvDir);
  const relFiles = files.map((f) => relative(mpvDir, f).replaceAll('\\', '/'));

  if (platform === 'win32') {
    if (!existsSync(join(mpvDir, 'elv-mpv.exe'))) {
      missing.push('resources/mpv/elv-mpv.exe');
    }
    if (!relFiles.some((f) => /(?:^|\/)(?:lib)?mpv[^/]*\.dll$/i.test(f))) {
      missing.push('resources/mpv/libmpv*.dll');
    }
    return;
  }

  if (platform === 'darwin') {
    const hasHelper =
      existsSync(join(mpvDir, 'ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv')) ||
      existsSync(join(mpvDir, 'ELV IPTV Player.app', 'Contents', 'MacOS', 'elv-mpv'));
    if (!hasHelper) {
      missing.push('resources/mpv/ELV IPTV Player.app/Contents/MacOS/mpv');
    }
    if (!relFiles.some((f) => /(?:^|\/)libmpv[^/]*\.dylib$/i.test(f))) {
      missing.push('resources/mpv/libmpv*.dylib');
    }
    return;
  }

  if (platform === 'linux') {
    const hasHelper =
      existsSync(join(mpvDir, 'elv-mpv')) ||
      existsSync(join(mpvDir, 'mpv')) ||
      relFiles.some((f) => /(?:^|\/)(?:elv-)?mpv$/i.test(f));
    if (!hasHelper) {
      missing.push('resources/mpv/mpv');
    }
    if (!relFiles.some((f) => /(?:^|\/)libmpv\.so(?:\.\d+)*$/i.test(f))) {
      missing.push('resources/mpv/libmpv.so*');
    }
  }
}

/**
 * Verifies a packaged desktop output directory end-to-end (`F-04`):
 * 1. Locates the platform Electron binary and verifies all 6 Electron fuses in the wire.
 * 2. Confirms required runtime resources (`app.asar`, `mpv/`, `mpv-input.conf`, `fonts/`, unpacked
 *    `better-sqlite3` prebuild inside `app.asar.unpacked`).
 * 3. Recursively scans the entire packaged directory and rejects any leaked secrets, source maps,
 *    test files, local databases, or internal artifacts.
 */
export function verifyDesktopPackageDir(
  packageDir: string,
  options: VerifyDesktopPackageOptions = {},
): DesktopPackageVerificationResult {
  const absDir = resolve(packageDir);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    return {
      ok: false,
      platform: 'unknown',
      binaryPath: null,
      resourcesDir: null,
      fuses: null,
      missingResources: [],
      leakedArtifacts: [],
      errors: [`Package directory does not exist: ${absDir}`],
    };
  }

  const layout = detectPackageLayout(absDir, options.platform);
  const errors: string[] = [];
  const missingResources: string[] = [];
  const leakedArtifacts: string[] = [];

  let fuses: FuseVerificationResult | null = null;
  if (layout.binaryPath === null) {
    errors.push(`Could not locate Electron binary inside package directory: ${absDir}`);
  } else {
    fuses = verifyElectronFusesInBinary(layout.binaryPath);
    if (!fuses.ok) {
      for (const err of fuses.errors) errors.push(err);
    }
  }

  if (layout.resourcesDir === null || !existsSync(layout.resourcesDir)) {
    missingResources.push('resources/');
  } else {
    const resDir = layout.resourcesDir;
    const asarPath = join(resDir, 'app.asar');
    if (!existsSync(asarPath) || !statSync(asarPath).isFile() || statSync(asarPath).size === 0) {
      missingResources.push('resources/app.asar');
    }

    const requireBundledMpv =
      options.requireBundledMpv ?? (layout.platform === 'win32' || layout.platform === 'darwin');
    if (requireBundledMpv) {
      checkPlatformMpvResources(resDir, layout.platform, missingResources);
    }

    const inputConfPath = join(resDir, 'mpv-input.conf');
    if (!existsSync(inputConfPath) || !statSync(inputConfPath).isFile()) {
      missingResources.push('resources/mpv-input.conf');
    }

    const fontsDir = join(resDir, 'fonts');
    if (!existsSync(fontsDir) || !statSync(fontsDir).isDirectory()) {
      missingResources.push('resources/fonts/');
    } else {
      const fontFiles = collectFilesSafely(fontsDir).files;
      if (!fontFiles.some((f) => /\.(?:ttf|otf)$/i.test(f))) {
        missingResources.push('resources/fonts/*.ttf|*.otf');
      }
    }

    const unpackedDir = join(resDir, 'app.asar.unpacked');
    if (!existsSync(unpackedDir) || !statSync(unpackedDir).isDirectory()) {
      missingResources.push('resources/app.asar.unpacked (better-sqlite3 prebuild)');
    } else {
      const unpackedFiles = collectFilesSafely(unpackedDir).files.map((f) =>
        relative(unpackedDir, f).replaceAll('\\', '/'),
      );
      if (!unpackedFiles.some((f) => /better-sqlite3\/.*\.node$/i.test(f))) {
        missingResources.push('resources/app.asar.unpacked/**/better-sqlite3/**/*.node');
      }
    }
  }

  for (const missing of missingResources) {
    errors.push(`Missing required packaged resource: ${missing}`);
  }

  const { files, dirs } = collectFilesSafely(absDir);
  const seenLeaks = new Set<string>();
  for (const item of [...dirs, ...files]) {
    const relPosix = relative(absDir, item).replaceAll('\\', '/');
    if (isForbiddenArtifactPath(relPosix) && !seenLeaks.has(relPosix)) {
      seenLeaks.add(relPosix);
      leakedArtifacts.push(relPosix);
    }
  }
  for (const leak of leakedArtifacts) {
    errors.push(`Forbidden artifact leaked into desktop package: ${leak}`);
  }

  return {
    ok: errors.length === 0,
    platform: layout.platform,
    binaryPath: layout.binaryPath,
    resourcesDir: layout.resourcesDir,
    fuses,
    missingResources,
    leakedArtifacts,
    errors,
  };
}

/** CLI runner for `node tools/src/verify-desktop-package.ts <packageDir>`. */
export function runVerifyDesktopPackageCli(
  argv: readonly string[] = process.argv.slice(2),
): number {
  let packageDir: string | undefined;
  let platform: 'win32' | 'darwin' | 'linux' | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--platform' && i + 1 < argv.length) {
      const val = argv[++i];
      if (val === 'win32' || val === 'darwin' || val === 'linux') platform = val;
    } else if (arg === '--config' && i + 1 < argv.length) {
      configPath = argv[++i];
    } else if (!arg.startsWith('-') && packageDir === undefined) {
      packageDir = arg;
    }
  }

  if (packageDir === undefined) {
    process.stderr.write(
      'Usage: node tools/src/verify-desktop-package.ts <packageDir> [--platform win32|darwin|linux] [--config electron-builder.yml]\n',
    );
    return 1;
  }

  const failures: string[] = [];

  if (configPath !== undefined) {
    const cfg = verifyElectronBuilderFusesConfig(configPath);
    process.stdout.write(`[config] ${cfg.ok ? 'PASS' : 'FAIL'} electronFuses (${configPath})\n`);
    if (!cfg.ok) failures.push(...cfg.errors);
  }

  const result = verifyDesktopPackageDir(packageDir, platform !== undefined ? { platform } : {});
  process.stdout.write(
    `[fuses] ${result.fuses?.ok ? 'PASS' : 'FAIL'} platform=${result.platform} sentinels=${result.fuses?.sentinelCount ?? 0}\n`,
  );
  process.stdout.write(
    `[resources] ${result.missingResources.length === 0 ? 'PASS' : 'FAIL'} missing=${result.missingResources.length}\n`,
  );
  process.stdout.write(
    `[hygiene] ${result.leakedArtifacts.length === 0 ? 'PASS' : 'FAIL'} leaked=${result.leakedArtifacts.length}\n`,
  );

  if (!result.ok) failures.push(...result.errors);
  for (const err of failures) {
    process.stderr.write(`  - ${err}\n`);
  }

  return failures.length === 0 ? 0 : 1;
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isExecutedDirectly()) {
  process.exit(runVerifyDesktopPackageCli());
}

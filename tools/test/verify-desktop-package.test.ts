import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ELECTRON_FUSE_SENTINEL,
  runVerifyDesktopPackageCli,
  verifyDesktopPackageDir,
  verifyElectronBuilderFusesConfig,
  verifyElectronFusesInBinary,
} from '../src/verify-desktop-package.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildFakeElectronBinary(
  fuses: readonly ('0' | '1' | 'r')[] = ['0', '1', '0', '0', '1', '1', '0', '1'],
  options?: { versionByte?: number; slices?: number },
): Buffer {
  const versionByte = options?.versionByte ?? 1;
  const slices = options?.slices ?? 1;
  const parts: Buffer[] = [];
  for (let s = 0; s < slices; s++) {
    parts.push(Buffer.from('ELF_OR_PE_PADDING_BEFORE', 'ascii'));
    parts.push(Buffer.from(ELECTRON_FUSE_SENTINEL, 'ascii'));
    parts.push(Buffer.from([versionByte, fuses.length]));
    parts.push(Buffer.from(fuses.join(''), 'ascii'));
    parts.push(Buffer.from('TRAILING_PADDING', 'ascii'));
  }
  return Buffer.concat(parts);
}

function createValidWindowsPackageDir(dir: string): void {
  writeFileSync(join(dir, 'ELV IPTV.exe'), buildFakeElectronBinary());
  const resources = join(dir, 'resources');
  mkdirSync(join(resources, 'mpv'), { recursive: true });
  mkdirSync(join(resources, 'fonts'), { recursive: true });
  mkdirSync(
    join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      'win32-x64',
    ),
    { recursive: true },
  );
  writeFileSync(join(resources, 'app.asar'), Buffer.from('ASAR_HEADER_DATA'));
  writeFileSync(join(resources, 'mpv', 'elv-mpv.exe'), Buffer.from('MZ'));
  writeFileSync(join(resources, 'mpv', 'libmpv-2.dll'), Buffer.from('MZ'));
  writeFileSync(join(resources, 'mpv-input.conf'), 'SPACE cycle pause\n', 'utf8');
  writeFileSync(
    join(resources, 'fonts', 'AtkinsonHyperlegibleNext-Regular.ttf'),
    Buffer.from('TTF'),
  );
  writeFileSync(
    join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      'win32-x64',
      'better_sqlite3.node',
    ),
    Buffer.from('NODE_ADDON'),
  );
}

function createValidMacAppPackageDir(dir: string): string {
  const appDir = join(dir, 'ELV IPTV.app');
  const fwDir = join(appDir, 'Contents', 'Frameworks', 'Electron Framework.framework');
  const macOsDir = join(appDir, 'Contents', 'MacOS');
  const resources = join(appDir, 'Contents', 'Resources');
  mkdirSync(fwDir, { recursive: true });
  mkdirSync(macOsDir, { recursive: true });
  mkdirSync(join(resources, 'mpv', 'ELV IPTV Player.app', 'Contents', 'MacOS'), {
    recursive: true,
  });
  mkdirSync(join(resources, 'mpv', 'ELV IPTV Player.app', 'Contents', 'Frameworks'), {
    recursive: true,
  });
  mkdirSync(join(resources, 'fonts'), { recursive: true });
  mkdirSync(
    join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      'darwin-arm64',
    ),
    { recursive: true },
  );
  writeFileSync(join(appDir, 'Contents', 'Info.plist'), '<plist/>', 'utf8');
  writeFileSync(join(macOsDir, 'ELV IPTV'), Buffer.from('MACHO'));
  writeFileSync(
    join(fwDir, 'Electron Framework'),
    buildFakeElectronBinary(undefined, { slices: 2 }),
  );
  writeFileSync(join(resources, 'app.asar'), Buffer.from('ASAR_HEADER_DATA'));
  writeFileSync(
    join(resources, 'mpv', 'ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv'),
    Buffer.from('MACHO'),
  );
  writeFileSync(
    join(resources, 'mpv', 'ELV IPTV Player.app', 'Contents', 'Frameworks', 'libmpv.2.dylib'),
    Buffer.from('MACHO'),
  );
  writeFileSync(join(resources, 'mpv-input.conf'), 'SPACE cycle pause\n', 'utf8');
  writeFileSync(join(resources, 'fonts', 'OpenDyslexic-Regular.otf'), Buffer.from('OTF'));
  writeFileSync(
    join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      'darwin-arm64',
      'better_sqlite3.node',
    ),
    Buffer.from('NODE_ADDON'),
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('verifyElectronBuilderFusesConfig', () => {
  it('passes against the real apps/desktop/electron-builder.yml', () => {
    const configPath = join(REPO_ROOT, 'apps', 'desktop', 'electron-builder.yml');
    const result = verifyElectronBuilderFusesConfig(configPath);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when any required fuse is missing or flipped to an insecure value', () => {
    const brokenYaml = [
      'electronFuses:',
      '  runAsNode: true',
      '  enableCookieEncryption: true',
      '  enableNodeOptionsEnvironmentVariable: false',
      '  enableNodeCliInspectArguments: false',
      '  enableEmbeddedAsarIntegrityValidation: false',
    ].join('\n');
    const result = verifyElectronBuilderFusesConfig(brokenYaml, { isRawYaml: true });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('runAsNode'))).toBe(true);
    expect(result.errors.some((e) => e.includes('enableEmbeddedAsarIntegrityValidation'))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes('onlyLoadAppFromAsar'))).toBe(true);
  });
});

describe('verifyElectronFusesInBinary', () => {
  it('passes when sentinel and all 6 required ELV fuses match wire v1', () => {
    const valid = verifyElectronFusesInBinary(buildFakeElectronBinary());
    expect(valid.ok).toBe(true);
    expect(valid.sentinelCount).toBe(1);
    expect(valid.fuseWireVersion).toBe(1);
    expect(valid.fuses['runAsNode']).toBe('0');
    expect(valid.fuses['onlyLoadAppFromAsar']).toBe('1');
  });

  it('fails on missing sentinel, wrong wire version, truncated wire, or flipped fuse', () => {
    const noSentinel = verifyElectronFusesInBinary(Buffer.from('plain binary'));
    expect(noSentinel.ok).toBe(false);
    expect(noSentinel.errors.some((e) => /sentinel/i.test(e))).toBe(true);

    const wrongVersion = verifyElectronFusesInBinary(
      buildFakeElectronBinary(undefined, { versionByte: 2 }),
    );
    expect(wrongVersion.ok).toBe(false);
    expect(wrongVersion.errors.some((e) => /version/i.test(e))).toBe(true);

    const flippedRunAsNode = verifyElectronFusesInBinary(
      buildFakeElectronBinary(['1', '1', '0', '0', '1', '1']),
    );
    expect(flippedRunAsNode.ok).toBe(false);
    expect(flippedRunAsNode.errors.some((e) => e.includes('runAsNode'))).toBe(true);

    const disabledAsarOnly = verifyElectronFusesInBinary(
      buildFakeElectronBinary(['0', '1', '0', '0', '1', '0']),
    );
    expect(disabledAsarOnly.ok).toBe(false);
    expect(disabledAsarOnly.errors.some((e) => e.includes('onlyLoadAppFromAsar'))).toBe(true);
  });
});

describe('verifyDesktopPackageDir', () => {
  it('passes for clean Windows and macOS (universal 2-slice) synthetic packaged dirs', () => {
    const winDir = makeTempDir('elv-pkg-win-');
    createValidWindowsPackageDir(winDir);
    const winResult = verifyDesktopPackageDir(winDir);
    expect(winResult.ok).toBe(true);
    expect(winResult.platform).toBe('win32');
    expect(winResult.missingResources).toEqual([]);
    expect(winResult.leakedArtifacts).toEqual([]);

    const macDir = makeTempDir('elv-pkg-mac-');
    createValidMacAppPackageDir(macDir);
    const macResult = verifyDesktopPackageDir(macDir);
    expect(macResult.ok).toBe(true);
    expect(macResult.platform).toBe('darwin');
    expect(macResult.fuses?.sentinelCount).toBe(2);

    // Linux builds do not bundle resources/mpv/ by default (matches electron-builder.yml)
    const linuxDir = makeTempDir('elv-pkg-linux-');
    writeFileSync(join(linuxDir, 'elv-iptv'), buildFakeElectronBinary());
    const linuxRes = join(linuxDir, 'resources');
    mkdirSync(join(linuxRes, 'fonts'), { recursive: true });
    mkdirSync(
      join(
        linuxRes,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        'linux-x64',
      ),
      { recursive: true },
    );
    writeFileSync(join(linuxRes, 'app.asar'), Buffer.from('ASAR_HEADER_DATA'));
    writeFileSync(join(linuxRes, 'mpv-input.conf'), 'SPACE cycle pause\n', 'utf8');
    writeFileSync(
      join(linuxRes, 'fonts', 'AtkinsonHyperlegibleNext-Regular.ttf'),
      Buffer.from('TTF'),
    );
    writeFileSync(
      join(
        linuxRes,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        'linux-x64',
        'better_sqlite3.node',
      ),
      Buffer.from('NODE_ADDON'),
    );

    const linuxDefaultResult = verifyDesktopPackageDir(linuxDir);
    expect(linuxDefaultResult.ok).toBe(true);
    expect(linuxDefaultResult.platform).toBe('linux');
    expect(linuxDefaultResult.missingResources).toEqual([]);

    // Explicit requireBundledMpv: true still enforces resources/mpv/ on Linux
    const linuxStrictMpvResult = verifyDesktopPackageDir(linuxDir, { requireBundledMpv: true });
    expect(linuxStrictMpvResult.ok).toBe(false);
    expect(linuxStrictMpvResult.missingResources).toContain('resources/mpv/');
  });

  it('fails when required runtime resources are missing', () => {
    const dir = makeTempDir('elv-pkg-missing-');
    createValidWindowsPackageDir(dir);
    rmSync(join(dir, 'resources', 'mpv-input.conf'));
    rmSync(join(dir, 'resources', 'mpv', 'libmpv-2.dll'));

    const result = verifyDesktopPackageDir(dir);
    expect(result.ok).toBe(false);
    expect(result.missingResources.some((m) => m.includes('mpv-input.conf'))).toBe(true);
    expect(result.missingResources.some((m) => m.includes('libmpv'))).toBe(true);
  });

  it('fails when forbidden secrets, source maps, test files, or internal artifacts leak into the package', () => {
    const dir = makeTempDir('elv-pkg-leaks-');
    createValidWindowsPackageDir(dir);
    writeFileSync(join(dir, '.env.local'), 'SECRET=1', 'utf8');
    writeFileSync(join(dir, 'resources', 'bundle.js.map'), '{}', 'utf8');
    writeFileSync(join(dir, 'resources', 'helper.test.ts'), '', 'utf8');
    writeFileSync(join(dir, 'resources', 'cert.pem'), 'KEY', 'utf8');
    writeFileSync(join(dir, 'resources', 'secrets.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'resources', 'catalog.db'), 'SQLITE', 'utf8');
    mkdirSync(join(dir, '.superpowers'), { recursive: true });
    writeFileSync(join(dir, '.superpowers', 'notes.md'), 'internal', 'utf8');

    const result = verifyDesktopPackageDir(dir);
    expect(result.ok).toBe(false);
    expect(result.leakedArtifacts.some((p) => p.includes('.env.local'))).toBe(true);
    expect(result.leakedArtifacts.some((p) => p.includes('bundle.js.map'))).toBe(true);
    expect(result.leakedArtifacts.some((p) => p.includes('helper.test.ts'))).toBe(true);
    expect(result.leakedArtifacts.some((p) => p.includes('cert.pem'))).toBe(true);
    expect(result.leakedArtifacts.some((p) => p.includes('secrets.json'))).toBe(true);
    expect(result.leakedArtifacts.some((p) => p.includes('catalog.db'))).toBe(true);
    expect(result.leakedArtifacts.some((p) => p.includes('.superpowers'))).toBe(true);
  });

  it('executes cleanly as a direct Node 24 CLI script and exits 0 on pass / 1 on fail', () => {
    const dir = makeTempDir('elv-pkg-cli-');
    createValidWindowsPackageDir(dir);
    const configPath = join(REPO_ROOT, 'apps', 'desktop', 'electron-builder.yml');
    const cliPath = join(REPO_ROOT, 'tools', 'src', 'verify-desktop-package.ts');

    const output = execFileSync(process.execPath, [cliPath, dir, '--config', configPath], {
      encoding: 'utf8',
    });
    expect(output).toContain('[config] PASS');
    expect(output).toContain('[fuses] PASS');
    expect(output).toContain('[resources] PASS');
    expect(output).toContain('[hygiene] PASS');

    expect(runVerifyDesktopPackageCli([])).toBe(1);
    writeFileSync(join(dir, '.env.local'), 'LEAK=1', 'utf8');
    expect(runVerifyDesktopPackageCli([dir])).toBe(1);
  });
});

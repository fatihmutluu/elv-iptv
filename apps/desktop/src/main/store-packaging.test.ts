import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDER_YML_PATH = join(DESKTOP_ROOT, 'electron-builder.yml');
const PACKAGE_JSON_PATH = join(DESKTOP_ROOT, 'package.json');
const RESOURCES_DIR = join(DESKTOP_ROOT, 'resources');
const APPX_DIR = join(RESOURCES_DIR, 'appx');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripYamlComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#(?=(?:[^"]*"[^"]*")*[^"]*$).*$/, ''))
    .join('\n');
}

function getTopLevelBlock(yamlText: string, key: string): string | null {
  const lines = stripYamlComments(yamlText).split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:\\s*$`).test(line));
  if (start === -1) return null;
  const blockLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break;
    blockLines.push(line);
  }
  return blockLines.join('\n');
}

describe('official desktop store packaging contract (#77, #486)', () => {
  it('declares UNLICENSED and official store packaging scripts in package.json', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      license?: string;
      scripts?: Record<string, string>;
    };

    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.scripts?.build).toBe('pnpm run prepare:app && electron-builder --publish never');
    expect(pkg.scripts?.['package:msix']).toBe(
      'pnpm run prepare:app && electron-builder --win appx --publish never',
    );
    expect(pkg.scripts?.['package:mas']).toBe(
      'pnpm run prepare:app && electron-builder --mac mas --publish never',
    );
  });

  it('retires standalone nsis/dmg installers, preserves all 6 electronFuses, and configures appx + mas + mac.extendInfo', () => {
    const raw = readFileSync(BUILDER_YML_PATH, 'utf8');
    const clean = stripYamlComments(raw);

    expect(getTopLevelBlock(raw, 'nsis')).toBeNull();
    expect(getTopLevelBlock(raw, 'dmg')).toBeNull();
    expect(clean).not.toMatch(/^\s*-\s*nsis\s*$/m);
    expect(clean).not.toMatch(/^\s*-\s*dmg\s*$/m);

    const fuses = getTopLevelBlock(raw, 'electronFuses');
    expect(fuses).not.toBeNull();
    for (const [key, value] of [
      ['runAsNode', 'false'],
      ['enableCookieEncryption', 'true'],
      ['enableNodeOptionsEnvironmentVariable', 'false'],
      ['enableNodeCliInspectArguments', 'false'],
      ['enableEmbeddedAsarIntegrityValidation', 'true'],
      ['onlyLoadAppFromAsar', 'true'],
    ] as const) {
      expect(fuses).toMatch(new RegExp(`^\\s*${key}\\s*:\\s*${value}\\s*$`, 'm'));
    }

    const winBlock = getTopLevelBlock(raw, 'win');
    expect(winBlock).toMatch(/^\s*target\s*:\s*\n\s*-\s*dir\s*$/m);

    const appxBlock = getTopLevelBlock(raw, 'appx');
    expect(appxBlock).not.toBeNull();
    expect(appxBlock).toMatch(/^\s*identityName\s*:\s*PLACEHOLDER\.StoreAssignedIdentity\s*$/m);
    expect(appxBlock).toMatch(/^\s*publisher\s*:\s*CN=PLACEHOLDER-StoreAssignedPublisher\s*$/m);
    expect(appxBlock).toMatch(/^\s*publisherDisplayName\s*:\s*ELV IPTV\s*$/m);
    expect(appxBlock).toMatch(/^\s*displayName\s*:\s*ELV IPTV\s*$/m);
    expect(appxBlock).toMatch(/^\s*applicationId\s*:\s*ELVIPTV\s*$/m);
    expect(appxBlock).toMatch(/^\s*backgroundColor\s*:\s*"#0b0e14"\s*$/m);
    expect(appxBlock).toMatch(/^\s*showNameOnTiles\s*:\s*true\s*$/m);
    expect(appxBlock).toMatch(/^\s*capabilities\s*:\s*$/m);
    expect(appxBlock).toMatch(/^\s*-\s*runFullTrust\s*$/m);
    expect(appxBlock).toMatch(/^\s*-\s*internetClient\s*$/m);
    expect(appxBlock).toMatch(/^\s*-\s*privateNetworkClientServer\s*$/m);
    expect(appxBlock).toMatch(/^\s*languages\s*:\s*$/m);
    expect(appxBlock).toMatch(/^\s*-\s*en-US\s*$/m);
    expect(appxBlock).toMatch(/^\s*-\s*tr-TR\s*$/m);

    const macBlock = getTopLevelBlock(raw, 'mac');
    expect(macBlock).not.toBeNull();
    expect(macBlock).toMatch(/^\s*target\s*:\s*\n\s*-\s*dir\s*$/m);
    expect(macBlock).toMatch(/^\s*extendInfo\s*:\s*$/m);
    expect(macBlock).toMatch(/^\s*ITSAppUsesNonExemptEncryption\s*:\s*false\s*$/m);
    expect(macBlock).toMatch(
      /^\s*NSLocalNetworkUsageDescription\s*:\s*"?ELV IPTV uses your local network to discover AirPlay receivers and pair devices over QR code\."?\s*$/m,
    );
    expect(macBlock).toMatch(/^\s*NSAppTransportSecurity\s*:\s*$/m);
    expect(macBlock).toMatch(/^\s*NSAllowsArbitraryLoads\s*:\s*true\s*$/m);

    const masBlock = getTopLevelBlock(raw, 'mas');
    expect(masBlock).not.toBeNull();
    expect(masBlock).toMatch(/^\s*identity\s*:\s*""\s*$/m);
    expect(masBlock).toMatch(/^\s*entitlements\s*:\s*resources\/entitlements\.mas\.plist\s*$/m);
    expect(masBlock).toMatch(
      /^\s*entitlementsInherit\s*:\s*resources\/entitlements\.mas\.inherit\.plist\s*$/m,
    );
    expect(masBlock).toMatch(/^\s*hardenedRuntime\s*:\s*false\s*$/m);
    expect(masBlock).toMatch(/^\s*category\s*:\s*public\.app-category\.entertainment\s*$/m);
    expect(masBlock).toMatch(/^\s*type\s*:\s*distribution\s*$/m);

    const linuxBlock = getTopLevelBlock(raw, 'linux');
    expect(linuxBlock).toMatch(/^\s*-\s*AppImage\s*$/m);
  });

  it.each([
    ['Square44x44Logo.png', 44, 44],
    ['Square150x150Logo.png', 150, 150],
    ['StoreLogo.png', 50, 50],
    ['Wide310x150Logo.png', 310, 150],
  ])('ships valid MSIX PNG tile asset %s (%ix%i)', (filename, expectedWidth, expectedHeight) => {
    const filePath = join(APPX_DIR, filename);
    expect(existsSync(filePath)).toBe(true);

    const buf = readFileSync(filePath);
    expect(buf.length).toBeGreaterThan(33);
    expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(buf.readUInt32BE(16)).toBe(expectedWidth);
    expect(buf.readUInt32BE(20)).toBe(expectedHeight);
  });

  it('declares required Mac App Store App Sandbox entitlements in both plists', () => {
    const masPlist = readFileSync(join(RESOURCES_DIR, 'entitlements.mas.plist'), 'utf8');
    for (const key of [
      'com.apple.security.app-sandbox',
      'com.apple.security.network.client',
      'com.apple.security.network.server',
      'com.apple.security.files.user-selected.read-write',
    ]) {
      expect(masPlist).toMatch(new RegExp(`<key>${key}</key>\\s*<true/>`));
    }
    expect(masPlist).toMatch(/<key>com\.apple\.security\.application-groups<\/key>\s*<array\s*\/>/);
    expect(masPlist).not.toContain('<string>io.github.fatihmutluu.elviptv</string>');

    const inheritPlist = readFileSync(
      join(RESOURCES_DIR, 'entitlements.mas.inherit.plist'),
      'utf8',
    );
    expect(inheritPlist).toMatch(/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
    expect(inheritPlist).toMatch(/<key>com\.apple\.security\.inherit<\/key>\s*<true\/>/);
  });
});

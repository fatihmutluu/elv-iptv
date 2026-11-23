import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { InfoPlist, XcodeProject } from 'expo/config-plugins';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_FONT_FILES,
  ANDROID_ACCESSIBILITY_FONT_MAP,
  accessibilityFontsSourceDir,
  applyAccessibilityFontsInfoPlist,
  applyAccessibilityFontsXcodeProject,
  copyAccessibilityFonts,
} from './with-accessibility-fonts.ts';

const require = createRequire(import.meta.url);
const xcode = require('xcode') as {
  project(filePath: string): { parseSync(): XcodeProject & { writeSync(): string } };
};
const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'tvos.pbxproj');
const APP_ROOT = path.resolve(import.meta.dirname, '..');

type Objects = Record<string, Record<string, unknown>>;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function parseFixture(): XcodeProject & { writeSync(): string } {
  return xcode.project(FIXTURE).parseSync();
}

function section(project: XcodeProject, isa: string): Objects {
  const objects = (project.hash as { project: { objects: Record<string, Objects> } }).project
    .objects;
  const out: Objects = {};
  for (const [key, value] of Object.entries(objects[isa] ?? {})) {
    if (!key.endsWith('_comment') && typeof value === 'object' && value !== null) out[key] = value;
  }
  return out;
}

function unquote(value: unknown): string {
  return String(value).replaceAll('"', '');
}

describe('withAccessibilityFonts (#163)', () => {
  it('resolves @elv/ui-kit/assets/fonts and verifies all 4 OFL-1.1 font binaries exist', () => {
    expect(ACCESSIBILITY_FONT_FILES).toEqual([
      'AtkinsonHyperlegibleNext-Regular.ttf',
      'AtkinsonHyperlegibleNext-Bold.ttf',
      'OpenDyslexic-Regular.otf',
      'OpenDyslexic-Bold.otf',
    ]);
    const sourceDir = accessibilityFontsSourceDir(APP_ROOT);
    expect(sourceDir.replaceAll('\\', '/')).toMatch(/\/packages\/ui-kit\/assets\/fonts$/);
    for (const file of ACCESSIBILITY_FONT_FILES) {
      expect(existsSync(path.join(sourceDir, file))).toBe(true);
    }
  });

  it('registers all 4 font filenames in Info.plist UIAppFonts and deduplicates repeated runs', () => {
    const plist: InfoPlist = {
      UIAppFonts: ['ExistingCustom.ttf', 'AtkinsonHyperlegibleNext-Regular.ttf'],
    };
    applyAccessibilityFontsInfoPlist(plist);
    applyAccessibilityFontsInfoPlist(plist);

    expect(plist.UIAppFonts).toEqual([
      'ExistingCustom.ttf',
      'AtkinsonHyperlegibleNext-Regular.ttf',
      'AtkinsonHyperlegibleNext-Bold.ttf',
      'OpenDyslexic-Regular.otf',
      'OpenDyslexic-Bold.otf',
    ]);

    const emptyPlist: InfoPlist = {};
    applyAccessibilityFontsInfoPlist(emptyPlist);
    expect(emptyPlist.UIAppFonts).toEqual([...ACCESSIBILITY_FONT_FILES]);
  });

  it('adds each font once to Xcode PBXGroup, PBXFileReference, PBXBuildFile, and Resources build phase', () => {
    const project = parseFixture();
    applyAccessibilityFontsXcodeProject(project, 'ELVIPTV');
    applyAccessibilityFontsXcodeProject(project, 'ELVIPTV');

    const fileRefs = Object.values(section(project, 'PBXFileReference'));
    const buildFiles = Object.values(section(project, 'PBXBuildFile'));
    const groups = Object.values(section(project, 'PBXGroup'));
    const appGroup = groups.find((g) => unquote(g.name) === 'ELVIPTV');
    const appGroupChildren = (appGroup?.children ?? []) as { value: string; comment: string }[];
    const resourcesPhases = Object.values(section(project, 'PBXResourcesBuildPhase'));
    const resourceFiles = resourcesPhases.flatMap(
      (phase) => (phase.files ?? []) as { value: string; comment: string }[],
    );

    for (const filename of ACCESSIBILITY_FONT_FILES) {
      const expectedPath = `ELVIPTV/Fonts/${filename}`;
      const matchingRefs = fileRefs.filter((ref) => unquote(ref.path) === expectedPath);
      expect(matchingRefs).toHaveLength(1);
      expect(matchingRefs[0]).not.toHaveProperty('fileEncoding');
      expect(matchingRefs[0]).not.toHaveProperty('explicitFileType');
      expect(matchingRefs[0]?.lastKnownFileType).toBe('file');

      const matchingGroupEntries = appGroupChildren.filter((child) => child.comment === filename);
      expect(matchingGroupEntries).toHaveLength(1);

      const matchingResources = resourceFiles.filter(
        (entry) => entry.comment === `${filename} in Resources`,
      );
      expect(matchingResources).toHaveLength(1);
    }

    const fontBuildFiles = buildFiles.filter((bf) =>
      ACCESSIBILITY_FONT_FILES.some((file) => String(bf.fileRef_comment ?? '') === file),
    );
    expect(fontBuildFiles).toHaveLength(ACCESSIBILITY_FONT_FILES.length);
    expect(project.writeSync()).not.toContain('= undefined;');
  });

  it('copies all 4 font files to Android (ReactFontManager names) and Apple destination directories and fails on missing sources', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'elv-a11y-fonts-'));
    tempDirs.push(tempRoot);
    const sourceDir = accessibilityFontsSourceDir(APP_ROOT);

    const androidFontsDir = path.join(tempRoot, 'android', 'app', 'src', 'main', 'assets', 'fonts');
    const iosFontsDir = path.join(tempRoot, 'ios', 'ELVIPTV', 'Fonts');

    const androidCopied = copyAccessibilityFonts(
      sourceDir,
      androidFontsDir,
      ACCESSIBILITY_FONT_FILES,
      ANDROID_ACCESSIBILITY_FONT_MAP,
    );
    const iosCopied = copyAccessibilityFonts(sourceDir, iosFontsDir);

    expect(androidCopied).toHaveLength(4);
    expect(iosCopied).toHaveLength(4);

    expect(readdirSync(androidFontsDir).sort()).toEqual([
      'AtkinsonHyperlegibleNext.ttf',
      'AtkinsonHyperlegibleNext_bold.ttf',
      'OpenDyslexic.otf',
      'OpenDyslexic_bold.otf',
    ]);
    expect(readdirSync(iosFontsDir).sort()).toEqual([...ACCESSIBILITY_FONT_FILES].sort());

    for (const filename of ACCESSIBILITY_FONT_FILES) {
      const expectedBytes = readFileSync(path.join(sourceDir, filename));
      const androidDestName = ANDROID_ACCESSIBILITY_FONT_MAP[filename];
      expect(readFileSync(path.join(androidFontsDir, androidDestName)).equals(expectedBytes)).toBe(
        true,
      );
      expect(readFileSync(path.join(iosFontsDir, filename)).equals(expectedBytes)).toBe(true);
    }

    expect(() =>
      copyAccessibilityFonts(path.join(tempRoot, 'does-not-exist'), path.join(tempRoot, 'out')),
    ).toThrow('Missing accessibility font binary');
  });
});

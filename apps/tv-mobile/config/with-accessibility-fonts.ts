import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type ConfigPlugin,
  type InfoPlist,
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  type XcodeProject,
} from 'expo/config-plugins';

/** Bundled `OFL-1.1` high-legibility accessibility font files packaged into Android and Apple apps (`#163`). */
export const ACCESSIBILITY_FONT_FILES = [
  'AtkinsonHyperlegibleNext-Regular.ttf',
  'AtkinsonHyperlegibleNext-Bold.ttf',
  'OpenDyslexic-Regular.otf',
  'OpenDyslexic-Bold.otf',
] as const;

/**
 * Android `app/src/main/assets/fonts/` destination filenames matching React Native Android's
 * `ReactFontManager` lookup convention (`<family>.ttf` / `<family>_bold.ttf`, `<family>.otf` /
 * `<family>_bold.otf`) so weight `>= 700` resolves to the bundled bold face with zero duplicate bytes (`#163`).
 */
export const ANDROID_ACCESSIBILITY_FONT_MAP: Readonly<
  Record<(typeof ACCESSIBILITY_FONT_FILES)[number], string>
> = {
  'AtkinsonHyperlegibleNext-Regular.ttf': 'AtkinsonHyperlegibleNext.ttf',
  'AtkinsonHyperlegibleNext-Bold.ttf': 'AtkinsonHyperlegibleNext_bold.ttf',
  'OpenDyslexic-Regular.otf': 'OpenDyslexic.otf',
  'OpenDyslexic-Bold.otf': 'OpenDyslexic_bold.otf',
};

type PbxObjects = Record<string, Record<string, unknown>>;

/** Absolute path of `@elv/ui-kit`'s canonical `assets/fonts` directory, resolved from the app's project root. */
export function accessibilityFontsSourceDir(projectRoot: string): string {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  const uiKitEntry = require.resolve('@elv/ui-kit');
  return path.resolve(path.dirname(uiKitEntry), '..', 'assets', 'fonts');
}

/**
 * Copies every accessibility font file from `sourceDir` into `destinationDir` (creating `destinationDir` if missing).
 * Throws if any expected font binary is absent so misconfigured builds fail loudly during `expo prebuild`.
 */
export function copyAccessibilityFonts(
  sourceDir: string,
  destinationDir: string,
  fontFiles: readonly string[] = ACCESSIBILITY_FONT_FILES,
  renameMap?: Readonly<Record<string, string>>,
): string[] {
  mkdirSync(destinationDir, { recursive: true });
  const copied: string[] = [];
  for (const filename of fontFiles) {
    const src = path.join(sourceDir, filename);
    if (!existsSync(src)) {
      throw new Error(`Missing accessibility font binary: ${src}`);
    }
    const destName = renameMap?.[filename] ?? filename;
    const dest = path.join(destinationDir, destName);
    copyFileSync(src, dest);
    copied.push(dest);
  }
  return copied;
}

/**
 * Registers the accessibility font filenames in Apple `Info.plist` `UIAppFonts` without duplicating entries
 * or disturbing any pre-existing `UIAppFonts` items.
 */
export function applyAccessibilityFontsInfoPlist(
  infoPlist: InfoPlist,
  fontFiles: readonly string[] = ACCESSIBILITY_FONT_FILES,
): InfoPlist {
  const existing = Array.isArray(infoPlist.UIAppFonts)
    ? infoPlist.UIAppFonts.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const merged = [...existing];
  for (const filename of fontFiles) {
    if (!merged.includes(filename)) {
      merged.push(filename);
    }
  }
  infoPlist.UIAppFonts = merged;
  return infoPlist;
}

function normalizeFontFileReferences(
  project: XcodeProject,
  projectName: string,
  fontFiles: readonly string[],
): void {
  const objects = (project.hash as { project?: { objects?: Record<string, PbxObjects> } }).project
    ?.objects;
  const refs = objects?.PBXFileReference;
  if (refs === undefined) return;
  const expectedPaths = new Set(fontFiles.map((file) => `${projectName}/Fonts/${file}`));
  for (const [key, entry] of Object.entries(refs)) {
    if (key.endsWith('_comment') || typeof entry !== 'object' || entry === null) continue;
    const rawPath = typeof entry.path === 'string' ? entry.path.replaceAll('"', '') : '';
    if (!expectedPaths.has(rawPath)) continue;
    if (entry.fileEncoding === undefined) delete entry.fileEncoding;
    if (entry.explicitFileType === undefined) delete entry.explicitFileType;
    if (entry.lastKnownFileType === 'unknown') entry.lastKnownFileType = 'file';
  }
}

/**
 * Adds the bundled accessibility font files (`<projectName>/Fonts/<file>`) to the Apple Xcode project's
 * `Resources` build phase idempotently using `IOSConfig.XcodeUtils.addResourceFileToGroup`.
 */
export function applyAccessibilityFontsXcodeProject(
  project: XcodeProject,
  projectName: string,
  fontFiles: readonly string[] = ACCESSIBILITY_FONT_FILES,
): XcodeProject {
  for (const filename of fontFiles) {
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: `${projectName}/Fonts/${filename}`,
      groupName: projectName,
      project,
      isBuildFile: true,
    });
  }
  normalizeFontFileReferences(project, projectName, fontFiles);
  return project;
}

/**
 * Zero-dependency Expo config plugin that packages the 4 `OFL-1.1` accessibility fonts (`#163`) into:
 * - Android `app/src/main/assets/fonts/`
 * - Apple `<projectName>/Fonts/`, `Info.plist` (`UIAppFonts`), and Xcode `Resources` build phase.
 */
export const withAccessibilityFonts: ConfigPlugin = (config) => {
  const withPlist = withInfoPlist(config, (cfg) => {
    applyAccessibilityFontsInfoPlist(cfg.modResults);
    return cfg;
  });

  const withProject = withXcodeProject(withPlist, (cfg) => {
    const projectName =
      cfg.modRequest.projectName ?? IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    applyAccessibilityFontsXcodeProject(cfg.modResults, projectName);
    return cfg;
  });

  const withAppleFiles = withDangerousMod(withProject, [
    'ios',
    (cfg) => {
      const projectName =
        cfg.modRequest.projectName ??
        IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const sourceDir = accessibilityFontsSourceDir(cfg.modRequest.projectRoot);
      const destDir = path.join(cfg.modRequest.platformProjectRoot, projectName, 'Fonts');
      copyAccessibilityFonts(sourceDir, destDir);
      return cfg;
    },
  ]);

  return withDangerousMod(withAppleFiles, [
    'android',
    (cfg) => {
      const sourceDir = accessibilityFontsSourceDir(cfg.modRequest.projectRoot);
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets',
        'fonts',
      );
      copyAccessibilityFonts(
        sourceDir,
        destDir,
        ACCESSIBILITY_FONT_FILES,
        ANDROID_ACCESSIBILITY_FONT_MAP,
      );
      return cfg;
    },
  ]);
};

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_GRADLE_PREFIXES = ['com.google.android.gms', 'com.google.firebase'] as const;
const FORBIDDEN_ANDROID_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
] as const;
const DEV_PACKAGE_ID = 'io.github.fatihmutluu.elviptv.dev';
const DEV_KEY_PATTERN = /(?<![A-Za-z0-9_])DEV_[A-Z0-9]+(?:_[A-Z0-9]+)*/g;
const GATE_FLAG_PATTERN = /(?:"gate"\s*:\s*true\b|\bgate\s*:\s*!0\b)/;
const DEV_SEED_MARKER = 'elv.dev.seeded';
const DEV_SEED_PAYLOAD_PATTERN = /(?:"seed"\s*:\s*\{|\bseed\s*:\s*\{\s*kind\s*:)/;
const REQUIRED_APPLE_PRIVACY_APIS = [
  { category: 'NSPrivacyAccessedAPICategoryUserDefaults', reason: 'CA92.1' },
  { category: 'NSPrivacyAccessedAPICategoryFileTimestamp', reason: 'C617.1' },
  { category: 'NSPrivacyAccessedAPICategorySystemBootTime', reason: '35F9.1' },
  { category: 'NSPrivacyAccessedAPICategoryDiskSpace', reason: 'E174.1' },
] as const;

export interface ManifestCheckOptions {
  readonly tv?: boolean;
}

export interface ReleaseHygieneOptions {
  readonly gradleDeps?: readonly string[];
  readonly androidManifests?: readonly string[];
  readonly applePlists?: readonly string[];
  readonly applePrivacyManifests?: readonly string[];
  readonly artifacts?: readonly string[];
  readonly tv?: boolean;
}

export interface ReleaseHygieneResult {
  readonly ok: boolean;
  readonly errors: string[];
}

/** Checks `gradlew :app:dependencies --configuration releaseRuntimeClasspath` output (`#11`). */
export function checkGradleDependencies(output: string): string[] {
  const errors: string[] = [];
  const hasTree =
    output.includes('releaseRuntimeClasspath') &&
    (output.includes('+---') || output.includes('\\---'));
  if (!hasTree) {
    errors.push('gradle dependencies output does not contain a releaseRuntimeClasspath tree');
    return errors;
  }
  for (const line of output.split(/\r?\n/)) {
    for (const forbidden of FORBIDDEN_GRADLE_PREFIXES) {
      if (line.includes(forbidden)) {
        errors.push(`forbidden dependency (${forbidden}): ${line.trim()}`);
      }
    }
  }
  return errors;
}

/** Checks merged release `AndroidManifest.xml` for `#11`, `#12`, `#19`, and `.dev` leaks. */
export function checkAndroidManifest(
  manifestXml: string,
  options: ManifestCheckOptions = {},
): string[] {
  const errors: string[] = [];
  const stripped = manifestXml.replace(/<!--[\s\S]*?-->/g, '');

  if (stripped.includes(DEV_PACKAGE_ID)) {
    errors.push(`manifest declares development package identifier ${DEV_PACKAGE_ID}`);
  }

  const permissionTag = /<uses-permission(?:-sdk-23)?\b[^>]*>/g;
  for (const match of stripped.matchAll(permissionTag)) {
    const tag = match[0];
    if (/tools:node\s*=\s*["']remove["']/.test(tag)) continue;
    for (const permission of FORBIDDEN_ANDROID_PERMISSIONS) {
      if (tag.includes(`"${permission}"`) || tag.includes(`'${permission}'`)) {
        errors.push(`forbidden Android permission in release manifest: ${permission}`);
      }
    }
  }

  for (const forbidden of FORBIDDEN_GRADLE_PREFIXES) {
    if (stripped.includes(forbidden)) {
      errors.push(`forbidden component/meta-data (${forbidden}) in release manifest`);
    }
  }

  const appTag = /<application\b[^>]*>/.exec(stripped)?.[0] ?? '';
  if (!/android:usesCleartextTraffic\s*=\s*["']true["']/.test(appTag)) {
    errors.push(
      'release manifest <application> must declare android:usesCleartextTraffic="true" (#12)',
    );
  }

  if (options.tv === true && !stripped.includes('android.software.leanback')) {
    errors.push('TV release manifest is missing android.software.leanback');
  }

  return errors;
}

/** Checks Apple release `Info.plist` XML for `#12` ATS settings and `.dev` bundle IDs. */
export function checkAppleInfoPlist(plistXml: string): string[] {
  const errors: string[] = [];
  const stripped = plistXml.replace(/<!--[\s\S]*?-->/g, '');

  if (stripped.includes(DEV_PACKAGE_ID)) {
    errors.push(`Info.plist declares development bundle identifier ${DEV_PACKAGE_ID}`);
  }
  if (stripped.includes('<key>NSAllowsLocalNetworking</key>')) {
    errors.push(
      'Info.plist must not declare NSAllowsLocalNetworking alongside NSAllowsArbitraryLoads (#12)',
    );
  }
  if (!/<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.test(stripped)) {
    errors.push('Info.plist must declare NSAllowsArbitraryLoads = true (#12)');
  }

  return errors;
}

/** Checks Apple `PrivacyInfo.xcprivacy` XML for `NSPrivacyTracking = false` and all 4 Required Reason APIs (#486). */
export function checkApplePrivacyManifest(privacyXml: string): string[] {
  const errors: string[] = [];
  const stripped = privacyXml.replace(/<!--[\s\S]*?-->/g, '');

  if (!/<plist\b[^>]*>[\s\S]*<dict>[\s\S]*<\/dict>[\s\S]*<\/plist>/.test(stripped)) {
    errors.push('PrivacyInfo.xcprivacy is empty or malformed XML plist');
    return errors;
  }

  if (stripped.includes(DEV_PACKAGE_ID)) {
    errors.push(`PrivacyInfo.xcprivacy references development identifier ${DEV_PACKAGE_ID}`);
  }

  if (/<key>NSPrivacyTracking<\/key>\s*<true\s*\/>/.test(stripped)) {
    errors.push('PrivacyInfo.xcprivacy must declare NSPrivacyTracking = false (found true)');
  } else if (!/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(stripped)) {
    errors.push('PrivacyInfo.xcprivacy must declare NSPrivacyTracking = false');
  }

  const declaredReasons = new Map<string, Set<string>>();
  const leafDictPattern = /<dict>(?:(?!<dict>)[\s\S])*?<\/dict>/g;
  for (const match of stripped.matchAll(leafDictPattern)) {
    const dict = match[0];
    const typeMatch = /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/.exec(dict);
    const rawCategory = typeMatch?.[1];
    if (rawCategory === undefined) continue;
    const category = rawCategory.trim();
    const reasons = declaredReasons.get(category) ?? new Set<string>();
    const arrayMatch =
      /<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(dict);
    const arrayBody = arrayMatch?.[1];
    if (arrayBody !== undefined) {
      for (const reasonMatch of arrayBody.matchAll(/<string>([^<]+)<\/string>/g)) {
        const rawReason = reasonMatch[1];
        if (rawReason !== undefined) reasons.add(rawReason.trim());
      }
    }
    declaredReasons.set(category, reasons);
  }

  for (const { category, reason } of REQUIRED_APPLE_PRIVACY_APIS) {
    const reasons = declaredReasons.get(category);
    if (reasons === undefined) {
      errors.push(
        `PrivacyInfo.xcprivacy is missing Required Reason API category ${category} (${reason})`,
      );
    } else if (!reasons.has(reason)) {
      errors.push(
        `PrivacyInfo.xcprivacy category ${category} is missing required reason code ${reason}`,
      );
    }
  }

  return errors;
}

function scanDecodedText(label: string, text: string, seen: Set<string>, errors: string[]): void {
  for (const match of text.matchAll(DEV_KEY_PATTERN)) {
    const token = match[0];
    const key = `dev:${token}`;
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(`${label}: contains development environment key "${token}"`);
    }
  }
  if (GATE_FLAG_PATTERN.test(text) && !seen.has('gate')) {
    seen.add('gate');
    errors.push(`${label}: enables development gate flag (gate: true)`);
  }
  if (text.includes(DEV_PACKAGE_ID) && !seen.has('dev-id')) {
    seen.add('dev-id');
    errors.push(`${label}: references development identifier "${DEV_PACKAGE_ID}"`);
  }
  if (text.includes(DEV_SEED_MARKER) && !seen.has('dev-seed-marker')) {
    seen.add('dev-seed-marker');
    errors.push(`${label}: contains development seeder marker "${DEV_SEED_MARKER}"`);
  }
  if (DEV_SEED_PAYLOAD_PATTERN.test(text) && !seen.has('dev-seed-payload')) {
    seen.add('dev-seed-payload');
    errors.push(`${label}: embeds development extra.seed payload`);
  }
}

/** Scans a release JS/HBC bundle, `app.config`, or `app.asar` byte buffer for dev-only leaks. */
export function checkReleaseArtifactBuffer(label: string, bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen = new Set<string>();
  const errors: string[] = [];

  scanDecodedText(label, buf.toString('latin1'), seen, errors);
  if (buf.byteLength >= 2) {
    const evenLen = buf.byteLength - (buf.byteLength % 2);
    scanDecodedText(label, buf.subarray(0, evenLen).toString('utf16le'), seen, errors);
    if (buf.byteLength >= 3) {
      const oddSlice = buf.subarray(1);
      const oddEvenLen = oddSlice.byteLength - (oddSlice.byteLength % 2);
      scanDecodedText(label, oddSlice.subarray(0, oddEvenLen).toString('utf16le'), seen, errors);
    }
  }

  return errors;
}

function collectFiles(targetPath: string): string[] {
  const stat = statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(targetPath, { recursive: true, encoding: 'utf8' })) {
    const full = join(targetPath, entry);
    if (statSync(full).isFile()) files.push(full);
  }
  return files;
}

/** Runs all configured release-hygiene checks and aggregates failures. */
export function runReleaseHygiene(options: ReleaseHygieneOptions): ReleaseHygieneResult {
  const errors: string[] = [];

  for (const file of options.gradleDeps ?? []) {
    if (!existsSync(file)) {
      errors.push(`missing gradle dependencies file: ${file}`);
      continue;
    }
    for (const err of checkGradleDependencies(readFileSync(file, 'utf8'))) {
      errors.push(`${file}: ${err}`);
    }
  }

  for (const file of options.androidManifests ?? []) {
    if (!existsSync(file)) {
      errors.push(`missing AndroidManifest.xml: ${file}`);
      continue;
    }
    for (const err of checkAndroidManifest(
      readFileSync(file, 'utf8'),
      options.tv !== undefined ? { tv: options.tv } : {},
    )) {
      errors.push(`${file}: ${err}`);
    }
  }

  for (const file of options.applePlists ?? []) {
    if (!existsSync(file)) {
      errors.push(`missing Info.plist: ${file}`);
      continue;
    }
    for (const err of checkAppleInfoPlist(readFileSync(file, 'utf8'))) {
      errors.push(`${file}: ${err}`);
    }
  }

  for (const file of options.applePrivacyManifests ?? []) {
    if (!existsSync(file)) {
      errors.push(`missing PrivacyInfo.xcprivacy: ${file}`);
      continue;
    }
    for (const err of checkApplePrivacyManifest(readFileSync(file, 'utf8'))) {
      errors.push(`${file}: ${err}`);
    }
  }

  for (const target of options.artifacts ?? []) {
    if (!existsSync(target)) {
      errors.push(`missing release artifact path: ${target}`);
      continue;
    }
    const files = collectFiles(target);
    if (files.length === 0) {
      errors.push(`no files found under release artifact path: ${target}`);
      continue;
    }
    for (const file of files) {
      errors.push(...checkReleaseArtifactBuffer(file, readFileSync(file)));
    }
  }

  return { ok: errors.length === 0, errors };
}

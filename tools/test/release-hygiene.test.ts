import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkAndroidManifest,
  checkAppleInfoPlist,
  checkApplePrivacyManifest,
  checkGradleDependencies,
  checkReleaseArtifactBuffer,
  runReleaseHygiene,
} from '../src/release-hygiene.ts';

const CLEAN_GRADLE_DEPS = `
> Task :app:dependencies

------------------------------------------------------------
Project ':app'
------------------------------------------------------------

releaseRuntimeClasspath - Runtime classpath of compilation 'release' (target  (androidJvm)).
+--- com.facebook.react:react-android:0.84.0
+--- androidx.media3:media3-exoplayer:1.9.3
\\--- com.squareup.okhttp3:okhttp:5.1.0
`;

const CLEAN_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="io.github.fatihmutluu.elviptv">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:name=".MainApplication"
        android:usesCleartextTraffic="true">
    </application>
</manifest>`;

const CLEAN_TV_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="io.github.fatihmutluu.elviptv">
    <uses-feature android:name="android.software.leanback" android:required="true" />
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:usesCleartextTraffic="true" />
</manifest>`;

const CLEAN_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>io.github.fatihmutluu.elviptv</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>`;

const CLEAN_PRIVACY_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array/>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>CA92.1</string>
      </array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>C617.1</string>
      </array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategorySystemBootTime</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>35F9.1</string>
      </array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryDiskSpace</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array>
        <string>E174.1</string>
      </array>
    </dict>
  </array>
</dict>
</plist>`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-hygiene-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkGradleDependencies (#11)', () => {
  it('accepts a clean releaseRuntimeClasspath tree', () => {
    expect(checkGradleDependencies(CLEAN_GRADLE_DEPS)).toEqual([]);
  });

  it('rejects empty or non-dependency output', () => {
    expect(checkGradleDependencies('')).not.toEqual([]);
    expect(checkGradleDependencies('BUILD SUCCESSFUL in 1s')).not.toEqual([]);
  });

  it('rejects Google Play Services and Firebase artifacts', () => {
    const withGms = `${CLEAN_GRADLE_DEPS}\n+--- com.google.android.gms:play-services-basement:18.4.0\n`;
    const withFirebase = `${CLEAN_GRADLE_DEPS}\n\\--- com.google.firebase:firebase-analytics:22.0.0\n`;

    expect(checkGradleDependencies(withGms).join('\n')).toContain('com.google.android.gms');
    expect(checkGradleDependencies(withFirebase).join('\n')).toContain('com.google.firebase');
  });
});

describe('checkAndroidManifest (#11, #12, #19)', () => {
  it('accepts clean phone and TV release manifests', () => {
    expect(checkAndroidManifest(CLEAN_MANIFEST)).toEqual([]);
    expect(checkAndroidManifest(CLEAN_TV_MANIFEST, { tv: true })).toEqual([]);
  });

  it('ignores XML comments and tools:node="remove" markers', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    package="io.github.fatihmutluu.elviptv">
    <!-- android.permission.READ_EXTERNAL_STORAGE -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" tools:node="remove" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" tools:node="remove" />
    <application android:usesCleartextTraffic="true" />
</manifest>`;
    expect(checkAndroidManifest(xml)).toEqual([]);
  });

  it('rejects READ_EXTERNAL_STORAGE and WRITE_EXTERNAL_STORAGE (#19)', () => {
    const withRead = CLEAN_MANIFEST.replace(
      '<application',
      '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n<application',
    );
    const withWrite = CLEAN_MANIFEST.replace(
      '<application',
      '<uses-permission-sdk-23 android:name="android.permission.WRITE_EXTERNAL_STORAGE" />\n<application',
    );
    expect(checkAndroidManifest(withRead).join('\n')).toContain('READ_EXTERNAL_STORAGE');
    expect(checkAndroidManifest(withWrite).join('\n')).toContain('WRITE_EXTERNAL_STORAGE');
  });

  it('rejects missing or false usesCleartextTraffic (#12)', () => {
    const missing = CLEAN_MANIFEST.replace('android:usesCleartextTraffic="true"', '');
    const disabled = CLEAN_MANIFEST.replace(
      'android:usesCleartextTraffic="true"',
      'android:usesCleartextTraffic="false"',
    );
    expect(checkAndroidManifest(missing).join('\n')).toContain('usesCleartextTraffic');
    expect(checkAndroidManifest(disabled).join('\n')).toContain('usesCleartextTraffic');
  });

  it('requires android.software.leanback when tv is true', () => {
    expect(checkAndroidManifest(CLEAN_MANIFEST, { tv: true }).join('\n')).toContain('leanback');
  });

  it('rejects .dev package identifiers and GMS/Firebase components', () => {
    const devPkg = CLEAN_MANIFEST.replace(
      'io.github.fatihmutluu.elviptv',
      'io.github.fatihmutluu.elviptv.dev',
    );
    const gmsMeta = CLEAN_MANIFEST.replace(
      '</application>',
      '<meta-data android:name="com.google.android.gms.version" android:value="12451000" /></application>',
    );
    expect(checkAndroidManifest(devPkg).join('\n')).toContain('.dev');
    expect(checkAndroidManifest(gmsMeta).join('\n')).toContain('com.google.android.gms');
  });
});

describe('checkAppleInfoPlist (#12)', () => {
  it('accepts clean production Info.plist with NSAllowsArbitraryLoads', () => {
    expect(checkAppleInfoPlist(CLEAN_INFO_PLIST)).toEqual([]);
  });

  it('rejects NSAllowsLocalNetworking alongside NSAllowsArbitraryLoads (#12)', () => {
    const broken = CLEAN_INFO_PLIST.replace(
      '<key>NSAllowsArbitraryLoads</key>\n    <true/>',
      '<key>NSAllowsArbitraryLoads</key>\n    <true/>\n    <key>NSAllowsLocalNetworking</key>\n    <true/>',
    );
    expect(checkAppleInfoPlist(broken).join('\n')).toContain('NSAllowsLocalNetworking');
  });

  it('rejects missing or disabled NSAllowsArbitraryLoads and .dev bundle IDs', () => {
    const disabled = CLEAN_INFO_PLIST.replace('<true/>', '<false/>');
    const devId = CLEAN_INFO_PLIST.replace(
      'io.github.fatihmutluu.elviptv',
      'io.github.fatihmutluu.elviptv.dev',
    );
    expect(checkAppleInfoPlist(disabled).join('\n')).toContain('NSAllowsArbitraryLoads');
    expect(checkAppleInfoPlist(devId).join('\n')).toContain('.dev');
  });
});

describe('checkApplePrivacyManifest (#486)', () => {
  it('accepts a clean PrivacyInfo.xcprivacy with NSPrivacyTracking=false and all 4 Required Reason APIs', () => {
    expect(checkApplePrivacyManifest(CLEAN_PRIVACY_MANIFEST)).toEqual([]);
  });

  it('rejects empty, malformed, or .dev-leaking privacy manifests', () => {
    expect(checkApplePrivacyManifest('').join('\n')).toContain('PrivacyInfo.xcprivacy');
    expect(checkApplePrivacyManifest('<not-a-plist/>').join('\n')).toContain(
      'PrivacyInfo.xcprivacy',
    );
    const devLeak = CLEAN_PRIVACY_MANIFEST.replace(
      '<array/>',
      '<array><string>io.github.fatihmutluu.elviptv.dev</string></array>',
    );
    expect(checkApplePrivacyManifest(devLeak).join('\n')).toContain('.dev');
  });

  it('rejects NSPrivacyTracking = true or missing NSPrivacyTracking', () => {
    const trackingTrue = CLEAN_PRIVACY_MANIFEST.replace(
      '<key>NSPrivacyTracking</key>\n  <false/>',
      '<key>NSPrivacyTracking</key>\n  <true/>',
    );
    const trackingMissing = CLEAN_PRIVACY_MANIFEST.replace(
      '<key>NSPrivacyTracking</key>\n  <false/>',
      '',
    );
    expect(checkApplePrivacyManifest(trackingTrue).join('\n')).toContain('NSPrivacyTracking');
    expect(checkApplePrivacyManifest(trackingMissing).join('\n')).toContain('NSPrivacyTracking');
  });

  it.each([
    ['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'],
    ['NSPrivacyAccessedAPICategoryFileTimestamp', 'C617.1'],
    ['NSPrivacyAccessedAPICategorySystemBootTime', '35F9.1'],
    ['NSPrivacyAccessedAPICategoryDiskSpace', 'E174.1'],
  ])('rejects missing category %s or wrong reason code (expected %s)', (category, reason) => {
    const missingCategory = CLEAN_PRIVACY_MANIFEST.replace(category, 'NSPrivacyAccessedAPIOther');
    expect(checkApplePrivacyManifest(missingCategory).join('\n')).toContain(category);

    const wrongReason = CLEAN_PRIVACY_MANIFEST.replace(reason, 'XXXX.9');
    const reasonErrors = checkApplePrivacyManifest(wrongReason).join('\n');
    expect(reasonErrors).toContain(category);
    expect(reasonErrors).toContain(reason);
  });

  it('rejects commented-out Required Reason API declarations', () => {
    const commented = CLEAN_PRIVACY_MANIFEST.replace(
      '<string>E174.1</string>',
      '<!-- <string>E174.1</string> -->',
    );
    expect(checkApplePrivacyManifest(commented).join('\n')).toContain('E174.1');
  });
});

describe('checkReleaseArtifactBuffer & runReleaseHygiene', () => {
  it('accepts clean JS bundles (__DEV__=false) and production app.config JSON', () => {
    const bundle = Buffer.from(
      'var __DEV__=false,name="ELV IPTV",pkg="io.github.fatihmutluu.elviptv";',
      'utf8',
    );
    const appConfig = Buffer.from(
      JSON.stringify({
        name: 'ELV IPTV',
        slug: 'elv-iptv',
        extra: { store: 'play', build: { commit: 'abc' } },
      }),
      'utf8',
    );
    expect(checkReleaseArtifactBuffer('index.js', bundle)).toEqual([]);
    expect(checkReleaseArtifactBuffer('app.config', appConfig)).toEqual([]);
  });

  it('rejects DEV_* keys, gate:true / gate:!0, and .dev package IDs in ASCII and UTF-16LE', () => {
    const devKey = Buffer.from('{"dev":{"DEV_XTREAM_PASSWORD":"synthetic-value"}}', 'utf8');
    const devUtf16 = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from('DEV_XTREAM_SERVER=http://127.0.0.1:7878', 'utf16le'),
    ]);
    const gateJson = Buffer.from('{"extra":{"store":"direct","gate":true}}', 'utf8');
    const gateMinified = Buffer.from('const extra={store:"direct",gate:!0};', 'utf8');
    const devBundleId = Buffer.from('bundleId="io.github.fatihmutluu.elviptv.dev"', 'utf8');

    expect(checkReleaseArtifactBuffer('app.config', devKey).join('\n')).toContain(
      'DEV_XTREAM_PASSWORD',
    );
    expect(checkReleaseArtifactBuffer('app.asar', devUtf16).join('\n')).toContain(
      'DEV_XTREAM_SERVER',
    );
    expect(checkReleaseArtifactBuffer('app.config', gateJson).join('\n')).toContain('gate');
    expect(checkReleaseArtifactBuffer('bundle.js', gateMinified).join('\n')).toContain('gate');
    expect(checkReleaseArtifactBuffer('app.asar', devBundleId).join('\n')).toContain('.dev');
  });

  it('rejects elv.dev.seeded and embedded extra.seed payloads in UTF-8 and UTF-16LE (#10)', () => {
    const seededMarkerUtf8 = Buffer.from('await secrets.get("elv.dev.seeded")', 'utf8');
    const seededMarkerUtf16 = Buffer.concat([
      Buffer.from([0xfe]),
      Buffer.from('const k="elv.dev.seeded";', 'utf16le'),
    ]);
    const seedPayloadUtf8 = Buffer.from(
      '{"extra":{"store":"direct","seed":{"kind":"xtream","server":"http://127.0.0.1:7878"}}}',
      'utf8',
    );
    const seedPayloadUtf16 = Buffer.from('{"seed":{"kind":"xtream","name":"Sim"}}', 'utf16le');

    expect(
      checkReleaseArtifactBuffer('index.android.bundle', seededMarkerUtf8).join('\n'),
    ).toContain('elv.dev.seeded');
    expect(checkReleaseArtifactBuffer('app.asar', seededMarkerUtf16).join('\n')).toContain(
      'elv.dev.seeded',
    );
    expect(checkReleaseArtifactBuffer('app.config', seedPayloadUtf8).join('\n')).toContain('seed');
    expect(checkReleaseArtifactBuffer('app.config', seedPayloadUtf16).join('\n')).toContain('seed');
  });

  it('walks artifact directories and fails on missing paths or hygiene violations via runReleaseHygiene', () => {
    const dir = makeTempDir();
    const depsFile = join(dir, 'deps.txt');
    const manifestFile = join(dir, 'AndroidManifest.xml');
    const plistFile = join(dir, 'Info.plist');
    const privacyFile = join(dir, 'PrivacyInfo.xcprivacy');
    const bundleDir = join(dir, 'bundle');
    rmSync(bundleDir, { recursive: true, force: true });

    writeFileSync(depsFile, CLEAN_GRADLE_DEPS, 'utf8');
    writeFileSync(manifestFile, CLEAN_TV_MANIFEST, 'utf8');
    writeFileSync(plistFile, CLEAN_INFO_PLIST, 'utf8');
    writeFileSync(privacyFile, CLEAN_PRIVACY_MANIFEST, 'utf8');

    const missingResult = runReleaseHygiene({
      gradleDeps: [depsFile],
      androidManifests: [manifestFile],
      applePlists: [plistFile],
      applePrivacyManifests: [join(dir, 'missing-PrivacyInfo.xcprivacy')],
      artifacts: [join(dir, 'does-not-exist.asar')],
      tv: true,
    });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join('\n')).toContain('missing PrivacyInfo.xcprivacy');

    const asarFile = join(dir, 'app.asar');
    writeFileSync(asarFile, 'HEADER{"files":{"index.js":{"size":24}}}var __DEV__=false;', 'utf8');
    const cleanResult = runReleaseHygiene({
      gradleDeps: [depsFile],
      androidManifests: [manifestFile],
      applePlists: [plistFile],
      applePrivacyManifests: [privacyFile],
      artifacts: [asarFile],
      tv: true,
    });
    expect(cleanResult).toEqual({ ok: true, errors: [] });

    writeFileSync(asarFile, 'HEADER{"extra":{"gate":true,"DEV_SEED":"1"}}', 'utf8');
    const dirtyResult = runReleaseHygiene({
      artifacts: [asarFile],
    });
    expect(dirtyResult.ok).toBe(false);
    expect(dirtyResult.errors.length).toBeGreaterThanOrEqual(2);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThirdPartyNotice } from './render.ts';

interface FfmpegMedia3LockFile {
  readonly repository: string;
  readonly workflow: string;
  readonly ffmpegVersion: string;
  readonly media3Version: string;
  readonly runId: string | null;
}

interface FfmpegMedia3VersionsFile {
  readonly ffmpeg: { readonly version: string; readonly url: string };
  readonly media3: {
    readonly version: string;
    readonly repository: string;
    readonly tag: string;
    readonly commit: string;
  };
  readonly decoders: readonly string[];
}

interface MpvRuntimeLockFile {
  readonly 'win32-x64': {
    readonly mpv: string;
    readonly url: string;
  };
  readonly 'darwin-arm64': {
    readonly mpv: string;
    readonly repo: string;
    readonly runId: number | string;
  };
}

interface MpvVersionsFile {
  readonly fribidi: { readonly version: string };
  readonly freetype: { readonly version: string };
  readonly harfbuzz: { readonly version: string };
  readonly libass: { readonly version: string };
  readonly libplacebo: { readonly version: string };
  readonly luajit: { readonly version: string };
  readonly ffmpeg: { readonly version: string; readonly url: string };
  readonly mpv: {
    readonly version: string;
    readonly url: string;
    readonly backports?: readonly { readonly path: string; readonly why: string }[];
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function stripGitSuffix(url: string): string {
  return url.replace(/\.git$/, '').replace(/\/+$/, '');
}

function collectAetherNotices(repoRoot: string): ThirdPartyNotice[] {
  const podspecPath = join(repoRoot, 'modules', 'engine-aether', 'ios', 'ElvEngineAether.podspec');
  const podspec = readFileSync(podspecPath, 'utf8');

  const urlMatch = /url:\s*'([^']+)'/.exec(podspec);
  const versionMatch = /kind:\s*'exactVersion',\s*version:\s*'([^']+)'/.exec(podspec);
  if (!urlMatch?.[1] || !versionMatch?.[1]) {
    throw new Error(`Could not parse AetherEngine git URL and exactVersion from ${podspecPath}`);
  }
  const baseRepoUrl = stripGitSuffix(urlMatch[1]);
  const version = versionMatch[1];
  const tagUrl = `${baseRepoUrl}/tree/${version}`;

  const checkBuildPath = join(repoRoot, 'modules', 'engine-aether', 'scripts', 'check-build.sh');
  const checkBuild = readFileSync(checkBuildPath, 'utf8');
  const fwMatch = /FRAMEWORKS="([^"]+)"/.exec(checkBuild);
  const frameworks = fwMatch?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (frameworks.length === 0) {
    throw new Error(`Could not parse dynamic AetherLib frameworks from ${checkBuildPath}`);
  }
  const frameworkList = frameworks.map((fw) => `${fw}.framework`).join(', ');
  const applePlatforms = ['iOS', 'iPadOS', 'tvOS'];

  return [
    {
      id: 'aether-engine',
      name: 'AetherEngine',
      version,
      license: 'LGPL-3.0-or-later WITH App-Store-DRM-exception',
      platforms: applePlatforms,
      sourceUrl: tagUrl,
      modificationNote: `Unmodified upstream tag ${version} integrated via Swift Package Manager with optional traits disabled. Our Xcode build phase strips framework headers, thins architectures, signs, and copies dSYMs without modifying AetherEngine source or binaries.`,
      noticeText: [
        `AetherEngine ${version} (${baseRepoUrl})`,
        'Licensed under the GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later) with the upstream App Store and DRM distribution exception covering AetherEngine Swift/Objective-C code.',
        `Corresponding upstream source code for tag ${version} is available at ${tagUrl}.`,
        `Dynamic LGPL media and codec frameworks (${frameworkList}) remain dynamically linked in Frameworks/ under their respective licenses.`,
      ].join('\n\n'),
    },
    {
      id: 'aether-ffmpeg',
      name: 'FFmpeg & Dynamic Frameworks (AetherLib*.framework)',
      version,
      license: 'LGPL-2.1-or-later',
      platforms: applePlatforms,
      sourceUrl: 'https://ffmpeg.org/',
      modificationNote: `Unmodified dynamic XCFramework slices from AetherEngine ${version} (${frameworkList}), lipo-thinned to target architectures and code-signed in Frameworks/ (@rpath) without --enable-gpl or --enable-nonfree.`,
      noticeText: [
        `FFmpeg and companion dynamic media frameworks (${frameworkList}) bundled via AetherEngine ${version}.`,
        'This software uses libraries from the FFmpeg project under the GNU Lesser General Public License version 2.1 or later (LGPL-2.1-or-later), linked dynamically without GPL or nonfree components.',
        `Upstream FFmpeg source code: https://ffmpeg.org/ | Apple XCFramework build scripts and tags: https://github.com/superuser404notfound/FFmpegBuild and ${tagUrl}.`,
      ].join('\n\n'),
    },
    {
      id: 'aether-codecs',
      name: 'libdovi, dav1d, zimg & zvbi (Apple Codec Libraries)',
      version,
      license: '(MIT OR Apache-2.0) AND BSD-2-Clause AND WTFPL AND LGPL-2.1-or-later',
      platforms: applePlatforms,
      sourceUrl: tagUrl,
      modificationNote: `Unmodified codec libraries distributed with AetherEngine ${version}.`,
      noticeText: [
        'libdovi — Copyright (c) quietvoid and contributors. Licensed under MIT OR Apache-2.0 (https://github.com/quietvoid/dovi_tool).',
        'dav1d (AetherLibdav1d.framework) — Copyright (c) 2018-2026 VideoLAN and dav1d authors. Licensed under the BSD 2-Clause License (https://code.videolan.org/videolan/dav1d).',
        'zimg (AetherLibzimg.framework) — Copyright (c) sekrit-twc. Licensed under the WTFPL v2 public-domain-equivalent permissive license (https://github.com/sekrit-twc/zimg).',
        'zvbi (AetherLibzvbi.framework) — Copyright (c) Michael H. Schimek and contributors. Dynamically linked under the GNU Lesser General Public License v2.1 or later (https://github.com/zapping-vbi/zvbi).',
      ].join('\n\n'),
    },
  ];
}

function collectMedia3Notices(repoRoot: string): ThirdPartyNotice[] {
  const lock = readJson<FfmpegMedia3LockFile>(
    join(repoRoot, 'modules', 'engine-media3', 'ffmpeg-media3.lock.json'),
  );
  const versions = readJson<FfmpegMedia3VersionsFile>(
    join(repoRoot, 'tools', 'ffmpeg-media3', 'versions.json'),
  );
  const androidPlatforms = ['Android', 'Android TV', 'Fire OS'];
  const media3Repo = stripGitSuffix(versions.media3.repository);
  const workflowUrl = `https://github.com/${lock.repository}/blob/main/.github/workflows/${lock.workflow}`;
  const runProvenance = lock.runId !== null ? `, run ${lock.runId}` : '';

  return [
    {
      id: 'androidx-media3',
      name: 'AndroidX Media3',
      version: lock.media3Version,
      license: 'Apache-2.0',
      platforms: androidPlatforms,
      sourceUrl: `${media3Repo}/tree/${lock.media3Version}`,
      modificationNote: `Unmodified AndroidX Media3 ${lock.media3Version} Maven libraries and upstream decoder_ffmpeg JNI/Java sources (commit ${versions.media3.commit}).`,
      noticeText: [
        `Copyright (C) The Android Open Source Project (AndroidX Media3 ${lock.media3Version}).`,
        'Licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).',
        `Upstream source code: ${media3Repo}/tree/${lock.media3Version}.`,
      ].join('\n\n'),
    },
    {
      id: 'ffmpeg-media3',
      name: 'FFmpeg (Android Media3 Audio Extension)',
      version: lock.ffmpegVersion,
      license: 'LGPL-2.1-or-later',
      platforms: androidPlatforms,
      sourceUrl: `https://ffmpeg.org/releases/ffmpeg-${lock.ffmpegVersion}.tar.xz`,
      modificationNote: `Unmodified FFmpeg ${lock.ffmpegVersion} source compiled as dynamic 16 KB-aligned ELF shared libraries (libavutil.so, libswresample.so, libavcodec.so, libffmpegJNI.so) without --enable-gpl or --enable-nonfree via tools/ffmpeg-media3/build-android.sh and ${lock.workflow} (${lock.repository}${runProvenance}).`,
      noticeText: [
        `This software uses libraries from the FFmpeg project (${lock.ffmpegVersion}) under the GNU Lesser General Public License v2.1 or later (LGPL-2.1-or-later), linked dynamically on Android.`,
        `Enabled audio decoders: ${versions.decoders.join(', ')}.`,
        `FFmpeg source archive: https://ffmpeg.org/releases/ffmpeg-${lock.ffmpegVersion}.tar.xz | Reproducible build script and CI workflow: ${workflowUrl}.`,
      ].join('\n\n'),
    },
  ];
}

function collectMpvNotices(repoRoot: string): ThirdPartyNotice[] {
  const lock = readJson<MpvRuntimeLockFile>(
    join(repoRoot, 'apps', 'desktop', 'mpv-runtime.lock.json'),
  );
  const versions = readJson<MpvVersionsFile>(
    join(repoRoot, 'tools', 'mpv-runtime', 'versions.json'),
  );
  const win = lock['win32-x64'];
  const mac = lock['darwin-arm64'];
  const mpvVersion = win.mpv === mac.mpv ? win.mpv : `${win.mpv} / ${mac.mpv}`;
  const workflowUrl = `https://github.com/${mac.repo}/blob/main/.github/workflows/mpv-runtime.yml`;
  const backportPaths = (versions.mpv.backports ?? []).map((b) => b.path).join(', ');
  const backportSummary =
    backportPaths.length > 0
      ? ` with upstream compile-fix backport (${backportPaths}) documented in tools/mpv-runtime/versions.json`
      : '';

  return [
    {
      id: 'desktop-libmpv',
      name: 'libmpv & FFmpeg (Desktop Player Runtime)',
      version: mpvVersion,
      license: 'LGPL-2.1-or-later AND ISC AND MIT AND FTL',
      platforms: ['Windows', 'macOS'],
      sourceUrl: `https://github.com/mpv-player/mpv/releases/tag/v${win.mpv}`,
      modificationNote: `Runs out-of-process over JSON IPC. Windows uses unmodified upstream LGPL release (${win.url}) loaded dynamically via LoadLibraryExW. macOS arm64 builds mpv ${mac.mpv} (-Dgpl=false) and FFmpeg ${versions.ffmpeg.version} (without --enable-gpl or --enable-nonfree) via mpv-runtime.yml (${mac.repo}, run ${String(mac.runId)})${backportSummary}.`,
      noticeText: [
        `mpv / libmpv ${mpvVersion} and FFmpeg ${versions.ffmpeg.version} — Licensed under the GNU Lesser General Public License v2.1 or later (LGPL-2.1-or-later), executed in a separate helper process and dynamically linked.`,
        `Windows LGPL binary & source release: ${win.url}.`,
        `macOS LGPL build recipe, source pins, and SHA-256 digests: ${workflowUrl} and https://github.com/${mac.repo}/blob/main/tools/mpv-runtime/versions.json (FFmpeg source: ${versions.ffmpeg.url}).`,
        `Companion libraries in macOS runtime: libplacebo ${versions.libplacebo.version} (LGPL-2.1-or-later), fribidi ${versions.fribidi.version} (LGPL-2.1-or-later), libass ${versions.libass.version} (ISC), HarfBuzz ${versions.harfbuzz.version} (Old-MIT), FreeType ${versions.freetype.version} (FTL), LuaJIT ${versions.luajit.version} (MIT).`,
      ].join('\n\n'),
    },
  ];
}

const ALL_PLATFORMS = [
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

/** Collects third-party notices for bundled OFL-1.1 accessibility typefaces (`#163`). */
function collectAccessibilityFontNotices(repoRoot: string): ThirdPartyNotice[] {
  const fontsDir = join(repoRoot, 'packages', 'ui-kit', 'assets', 'fonts');
  const atkinsonOfl = readFileSync(join(fontsDir, 'AtkinsonHyperlegibleNext-OFL.txt'), 'utf8')
    .replace(/\r\n/g, '\n')
    .trim();
  const openDyslexicOfl = readFileSync(join(fontsDir, 'OpenDyslexic-OFL.txt'), 'utf8')
    .replace(/\r\n/g, '\n')
    .trim();

  return [
    {
      id: 'atkinson-hyperlegible-next',
      name: 'Atkinson Hyperlegible Next',
      version: 'bundled',
      license: 'OFL-1.1',
      platforms: ALL_PLATFORMS,
      sourceUrl: 'https://github.com/googlefonts/atkinson-hyperlegible-next',
      modificationNote:
        'Unmodified Regular and Bold TTF binaries bundled for high-legibility UI and subtitle rendering.',
      noticeText: atkinsonOfl,
    },
    {
      id: 'opendyslexic',
      name: 'OpenDyslexic',
      version: 'bundled',
      license: 'OFL-1.1',
      platforms: ALL_PLATFORMS,
      sourceUrl: 'https://github.com/antijingoist/opendyslexic',
      modificationNote:
        'Unmodified Regular and Bold OTF binaries bundled for dyslexia-friendly UI and subtitle rendering.',
      noticeText: openDyslexicOfl,
    },
  ];
}

/** Collects pinned native media engine and bundled accessibility font notices. */
export function collectNativeNotices(repoRoot: string): ThirdPartyNotice[] {
  return [
    ...collectAetherNotices(repoRoot),
    ...collectMedia3Notices(repoRoot),
    ...collectMpvNotices(repoRoot),
    ...collectAccessibilityFontNotices(repoRoot),
  ];
}

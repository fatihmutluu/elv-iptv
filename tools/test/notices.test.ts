import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChecks } from '../src/checks.ts';
import {
  collectNotices,
  NOTICES_OUTPUT_REL,
  renderNoticesModule,
  scanBannedCopy,
  verifyNoticesFile,
  writeNoticesFile,
} from '../src/notices/generate.ts';
import { findRepoRoot } from '../src/root.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeRepoFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function addFakeNodeModule(
  root: string,
  name: string,
  version: string,
  homepage: string,
  licenseText: string,
): void {
  writeRepoFile(
    root,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version, license: 'MIT', homepage }),
  );
  writeRepoFile(root, `node_modules/${name}/LICENSE`, licenseText);
}

function createSyntheticRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv_notices_test_'));
  tempDirs.push(dir);

  writeRepoFile(
    dir,
    'pnpm-workspace.yaml',
    'packages:\n  - apps/*\n  - packages/*\n  - modules/*\n',
  );
  writeRepoFile(
    dir,
    'package.json',
    JSON.stringify({ name: 'elv-iptv', private: true, license: 'GPL-3.0-only' }),
  );

  writeRepoFile(
    dir,
    'modules/engine-aether/package.json',
    JSON.stringify({
      name: '@elv/engine-aether',
      license: 'GPL-3.0-only',
      dependencies: { '@elv/playback': 'workspace:*', 'expo-modules-core': '58.1.0' },
    }),
  );
  writeRepoFile(
    dir,
    'modules/engine-aether/ios/ElvEngineAether.podspec',
    [
      'Pod::Spec.new do |s|',
      "  s.name = 'ElvEngineAether'",
      '  spm_dependency(s,',
      "    url: 'https://github.com/superuser404notfound/AetherEngine.git',",
      "    requirement: { kind: 'exactVersion', version: '7.66.1' },",
      "    products: ['AetherEngine']",
      '  )',
      'end',
      '',
    ].join('\n'),
  );
  writeRepoFile(
    dir,
    'modules/engine-aether/scripts/check-build.sh',
    '#!/bin/sh\nFRAMEWORKS="AetherLibavcodec AetherLibavfilter AetherLibavformat AetherLibavutil AetherLibdav1d AetherLibswresample AetherLibswscale AetherLibzimg AetherLibzvbi"\n',
  );

  writeRepoFile(
    dir,
    'modules/engine-media3/package.json',
    JSON.stringify({
      name: '@elv/engine-media3',
      license: 'GPL-3.0-only',
      dependencies: { '@elv/playback': 'workspace:*' },
    }),
  );
  writeRepoFile(
    dir,
    'modules/engine-media3/ffmpeg-media3.lock.json',
    JSON.stringify({
      repository: 'fatihmutluu/elv-iptv',
      workflow: 'ffmpeg-media3.yml',
      artifactName: 'ffmpeg-media3-android',
      ffmpegVersion: '9.0.2',
      media3Version: '1.11.1',
      runId: '43707260644',
      sha256: 'febcc8ea4638531fb962d9bc3361c1299acf58cabefdbbe4f5e1b96cb2829a71',
    }),
  );
  writeRepoFile(
    dir,
    'tools/ffmpeg-media3/versions.json',
    JSON.stringify({
      ffmpeg: { version: '9.0.2', url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz' },
      media3: {
        version: '1.11.1',
        repository: 'https://github.com/androidx/media.git',
        tag: '1.11.1',
        commit: '8c6678b657ede1e7883fc164ef73ed483c7796c3',
      },
      decoders: ['aac', 'ac3', 'eac3', 'opus'],
    }),
  );

  writeRepoFile(
    dir,
    'apps/desktop/package.json',
    JSON.stringify({
      name: '@elv/desktop',
      license: 'GPL-3.0-only',
      dependencies: { 'better-sqlite3': '13.0.3' },
      devDependencies: { electron: '45.3.1' },
    }),
  );
  writeRepoFile(
    dir,
    'apps/desktop/renderer/package.json',
    JSON.stringify({
      name: '@elv/desktop-renderer',
      license: 'GPL-3.0-only',
      dependencies: { react: '19.3.0' },
    }),
  );
  writeRepoFile(
    dir,
    'apps/desktop/mpv-runtime.lock.json',
    JSON.stringify({
      'win32-x64': {
        kind: 'upstream-libmpv',
        mpv: '0.42.0',
        url: 'https://github.com/mpv-player/mpv/releases/download/v0.42.0/libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip',
        sha256: '8e5f77430efc53ef175804ba6618527e3af0448a0dcabf04d3cc72659d1a6fce',
      },
      'darwin-arm64': {
        kind: 'workflow-artifact',
        mpv: '0.42.0',
        repo: 'fatihmutluu/elv-iptv',
        runId: 43641362989,
        artifact: 'mpv-runtime-darwin-arm64',
        file: 'mpv-runtime-darwin-arm64.tar.gz',
        sha256: '10eb65c586d944d0a96b47f6226834d6bc43c9f3ced6d9d6bae9518f50cc48b6',
      },
    }),
  );
  writeRepoFile(
    dir,
    'tools/mpv-runtime/versions.json',
    JSON.stringify({
      fribidi: { version: '1.0.18' },
      freetype: { version: '2.15.0' },
      harfbuzz: { version: '15.1.0' },
      libass: { version: '0.17.5' },
      libplacebo: { version: '7.387.0' },
      luajit: { version: '2.1' },
      ffmpeg: { version: '9.0.2', url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz' },
      mpv: {
        version: '0.42.0',
        url: 'https://github.com/mpv-player/mpv/archive/v0.42.0/mpv-0.42.0.tar.gz',
        backports: [{ path: 'video/out/mac/view.swift', why: 'macOS build fix' }],
      },
    }),
  );

  writeRepoFile(
    dir,
    'apps/tv-mobile/package.json',
    JSON.stringify({
      name: 'tv-mobile',
      license: 'GPL-3.0-only',
      dependencies: { '@op-engineering/op-sqlite': '19.0.5', react: '19.3.0' },
    }),
  );
  writeRepoFile(
    dir,
    'packages/features/package.json',
    JSON.stringify({ name: '@elv/features', license: 'GPL-3.0-only', dependencies: {} }),
  );

  addFakeNodeModule(
    dir,
    '@op-engineering/op-sqlite',
    '19.0.5',
    'https://github.com/OP-Engineering/op-sqlite',
    'MIT License\nCopyright 2021 Oscar Franco\n',
  );
  addFakeNodeModule(
    dir,
    'better-sqlite3',
    '13.0.3',
    'https://github.com/WiseLibs/better-sqlite3',
    'MIT License\nCopyright (c) 2017 Joshua Wise\n',
  );
  addFakeNodeModule(
    dir,
    'electron',
    '45.3.1',
    'https://github.com/electron/electron',
    'MIT License\nCopyright (c) Electron contributors\n',
  );
  addFakeNodeModule(
    dir,
    'expo-modules-core',
    '58.1.0',
    'https://github.com/expo/expo',
    'MIT License\nCopyright (c) 650 Industries, Inc.\n',
  );
  addFakeNodeModule(
    dir,
    'react',
    '19.3.0',
    'https://react.dev/',
    'MIT License\nCopyright (c) Meta Platforms, Inc.\n',
  );

  return dir;
}

describe('third-party notices generator and drift verifier', () => {
  it('collects native LGPL/permissive components and shipped workspace JS packages from the real repository', () => {
    const repoRoot = findRepoRoot(import.meta.dirname);
    const notices = collectNotices(repoRoot);
    const byId = new Map(notices.map((n) => [n.id, n]));

    const aether = byId.get('aether-engine');
    expect(aether?.version).toBe('7.66.1');
    expect(aether?.license).toContain('LGPL-3.0');
    expect(aether?.license.toLowerCase()).toContain('exception');
    expect(aether?.sourceUrl).toBe(
      'https://github.com/superuser404notfound/AetherEngine/tree/7.66.1',
    );
    expect(aether?.modificationNote?.toLowerCase()).toContain('unmodified');
    expect(aether?.platforms).toEqual(['iOS', 'iPadOS', 'tvOS']);

    const aetherFfmpeg = byId.get('aether-ffmpeg');
    expect(aetherFfmpeg?.version).toBe('7.66.1');
    expect(aetherFfmpeg?.license).toContain('LGPL-2.1');
    for (const fw of [
      'AetherLibavcodec',
      'AetherLibavfilter',
      'AetherLibavformat',
      'AetherLibavutil',
      'AetherLibdav1d',
      'AetherLibswresample',
      'AetherLibswscale',
      'AetherLibzimg',
      'AetherLibzvbi',
    ]) {
      expect(
        `${aetherFfmpeg?.modificationNote ?? ''}\n${aetherFfmpeg?.noticeText ?? ''}`,
      ).toContain(fw);
    }

    const aetherCodecs = byId.get('aether-codecs');
    for (const lib of ['libdovi', 'dav1d', 'zimg', 'zvbi']) {
      expect(`${aetherCodecs?.name ?? ''}\n${aetherCodecs?.noticeText ?? ''}`).toContain(lib);
    }

    const media3 = byId.get('androidx-media3');
    expect(media3?.version).toBe('1.11.1');
    expect(media3?.license).toBe('Apache-2.0');
    expect(media3?.platforms).toEqual(['Android', 'Android TV', 'Fire OS']);

    const ffmpegAndroid = byId.get('ffmpeg-media3');
    expect(ffmpegAndroid?.version).toBe('9.0.2');
    expect(ffmpegAndroid?.license).toContain('LGPL-2.1');
    expect(
      `${ffmpegAndroid?.modificationNote ?? ''}\n${ffmpegAndroid?.noticeText ?? ''}`,
    ).toContain('ffmpeg-media3.yml');

    const mpv = byId.get('desktop-libmpv');
    expect(mpv?.version).toBe('0.42.0');
    expect(mpv?.license).toContain('LGPL-2.1');
    expect(`${mpv?.modificationNote ?? ''}\n${mpv?.noticeText ?? ''}`).toContain('mpv-runtime.yml');
    expect(`${mpv?.modificationNote ?? ''}\n${mpv?.noticeText ?? ''}`).toContain(
      'github.com/mpv-player/mpv/releases/download/v0.42.0',
    );

    for (const expectedName of [
      '@op-engineering/op-sqlite',
      'better-sqlite3',
      'electron',
      'react',
      'expo',
      'expo-modules-core',
      '@lingui/core',
    ]) {
      expect(
        notices.some((n) => n.name === expectedName || n.name.startsWith(`${expectedName} `)),
        `expected notice for ${expectedName}`,
      ).toBe(true);
    }
    expect(notices.some((n) => n.name.includes('react-native'))).toBe(true);

    const rendered = renderNoticesModule(notices);
    expect(rendered.split('\n').length).toBeLessThan(400);
    expect(scanBannedCopy(rendered)).toEqual([]);
  });

  it('detects drift when native lock versions or runtime dependencies change without regenerating notices-data.ts', () => {
    const repo = createSyntheticRepo();
    writeNoticesFile(repo);
    expect(verifyNoticesFile(repo)).toEqual({ ok: true, errors: [] });

    const media3LockPath = join(repo, 'modules/engine-media3/ffmpeg-media3.lock.json');
    const origMedia3Lock = readFileSync(media3LockPath, 'utf8');
    writeFileSync(media3LockPath, origMedia3Lock.replace('"9.0.2"', '"9.1.0"'));
    const ffmpegDrift = verifyNoticesFile(repo);
    expect(ffmpegDrift.ok).toBe(false);
    expect(ffmpegDrift.errors.join('\n')).toContain('pnpm notices:sync');
    expect(ffmpegDrift.errors.join('\n')).toContain('9.1.0');
    writeFileSync(media3LockPath, origMedia3Lock);

    const mpvLockPath = join(repo, 'apps/desktop/mpv-runtime.lock.json');
    const origMpvLock = readFileSync(mpvLockPath, 'utf8');
    writeFileSync(mpvLockPath, origMpvLock.replaceAll('0.42.0', '0.43.0'));
    const mpvDrift = verifyNoticesFile(repo);
    expect(mpvDrift.ok).toBe(false);
    expect(mpvDrift.errors.join('\n')).toContain('0.43.0');
    writeFileSync(mpvLockPath, origMpvLock);

    const podspecPath = join(repo, 'modules/engine-aether/ios/ElvEngineAether.podspec');
    const origPodspec = readFileSync(podspecPath, 'utf8');
    writeFileSync(podspecPath, origPodspec.replace('7.66.1', '7.68.0'));
    const aetherDrift = verifyNoticesFile(repo);
    expect(aetherDrift.ok).toBe(false);
    expect(aetherDrift.errors.join('\n')).toContain('7.68.0');
    writeFileSync(podspecPath, origPodspec);
    expect(verifyNoticesFile(repo).ok).toBe(true);

    addFakeNodeModule(
      repo,
      'zustand',
      '5.0.1',
      'https://github.com/pmndrs/zustand',
      'MIT License\n',
    );
    writeRepoFile(
      repo,
      'packages/features/package.json',
      JSON.stringify({
        name: '@elv/features',
        license: 'GPL-3.0-only',
        dependencies: { zustand: '5.0.1' },
      }),
    );
    const depDrift = verifyNoticesFile(repo);
    expect(depDrift.ok).toBe(false);
    expect(depDrift.errors.join('\n')).toContain('zustand');

    writeNoticesFile(repo);
    expect(verifyNoticesFile(repo)).toEqual({ ok: true, errors: [] });
    expect(readFileSync(join(repo, NOTICES_OUTPUT_REL), 'utf8')).toContain('zustand');
  });

  it('rejects banned public-copy terms and secret markers, and registers the notices check in buildChecks', async () => {
    expect(scanBannedCopy('Clean MIT notice text')).toEqual([]);
    expect(scanBannedCopy('Includes TiviMate compatibility').length).toBeGreaterThan(0);
    expect(scanBannedCopy('Supports DVR recording').length).toBeGreaterThan(0);
    expect(scanBannedCopy('DEV_XTREAM_PASSWORD=secret').length).toBeGreaterThan(0);

    const repo = createSyntheticRepo();
    writeNoticesFile(repo);
    const check = buildChecks(repo).find((c) => c.key === 'notices');
    if (!check) throw new Error('missing notices check');

    expect((await check.run()).ok).toBe(true);

    const outPath = join(repo, NOTICES_OUTPUT_REL);
    cpSync(outPath, `${outPath}.bak`);
    writeFileSync(outPath, '// stale\n');
    const res = await check.run();
    expect(res.ok).toBe(false);
    expect(res.output).toContain('pnpm notices:sync');
  });
});

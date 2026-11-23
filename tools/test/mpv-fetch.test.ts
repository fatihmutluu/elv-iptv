import { describe, expect, it } from 'vitest';
import { type FetchDeps, fetchRuntime, verifyDirectory, verifyRuntime } from '../src/mpv/fetch.ts';
import { parseLock } from '../src/mpv/lock.ts';

const HASH = 'a'.repeat(64);
const LOCK = parseLock({
  'win32-x64': {
    kind: 'upstream-libmpv',
    mpv: '0.42.0',
    url: 'https://github.com/mpv-player/mpv/releases/download/v0.42.0/x.zip',
    sha256: HASH,
  },
});
const enc = (s: string): Uint8Array => new TextEncoder().encode(`\u0000${s}\u0000`);
const LGPL = enc(
  '--prefix=/x --enable-version3 --disable-libx264 --disable-librubberband\u0000-Dgpl=false -Dlua=luajit',
);
const GPL = enc('--prefix=/x --enable-gpl --enable-version3 --disable-a\u0000-Dgpl=false');
const FFMPEG = enc('--prefix=/p --enable-shared --disable-static --disable-programs');
const MPV = enc('-Dgpl=false -Dcplayer=true -Dlua=luajit');

interface Fake {
  deps: FetchDeps;
  written: Map<string, string>;
  downloads: string[];
  downloadedTo: string[];
  logs: string[];
  extractedTo: string[];
  builds: string[];
  /** Side effects in call order, for example `gh o/r 5 a /repo/.cache/mpv/darwin-arm64`. */
  events: string[];
  reads: string[];
}

function fake(
  opts: {
    hash?: string;
    /** Hashes returned by successive sha256 calls; the last one repeats. */
    hashes?: string[];
    dll?: Uint8Array;
    files?: Record<string, string>;
    cached?: boolean;
    extraPaths?: string[];
    symlinks?: string[];
    launcherHash?: string | null;
    /** Extracted content by relative path; replaces the Windows archive layout. */
    archive?: Record<string, Uint8Array>;
  } = {},
): Fake {
  const written = new Map<string, string>(Object.entries(opts.files ?? {}));
  const downloads: string[] = [];
  const downloadedTo: string[] = [];
  const logs: string[] = [];
  const extractedTo: string[] = [];
  const builds: string[] = [];
  const events: string[] = [];
  const reads: string[] = [];
  const archive = opts.archive;
  let hashCalls = 0;
  const deps: FetchDeps = {
    async download(url, file) {
      downloads.push(url);
      downloadedTo.push(file);
      written.set(file, 'archive');
    },
    async ghArtifact(entry, dir) {
      events.push(`gh ${entry.repo} ${entry.runId} ${entry.artifact} ${dir}`);
      written.set(`${dir}/${entry.file}`, 'tar');
    },
    async sha256(file) {
      events.push(`sha256 ${file}`);
      const seq = opts.hashes;
      if (seq !== undefined) return seq[Math.min(hashCalls++, seq.length - 1)] as string;
      return opts.hash ?? HASH;
    },
    async extract(archivePath, dir) {
      extractedTo.push(dir);
      events.push(`extract ${archivePath} ${dir}`);
      if (archive !== undefined) {
        for (const p of Object.keys(archive)) written.set(`${dir}/${p}`, 'bin');
        return;
      }
      written.set(`${dir}/libmpv-2.dll`, 'dll');
      written.set(`${dir}/LICENSE.LGPL`, 'lic');
      written.set(`${dir}/include/mpv/client.h`, 'h');
      for (const p of opts.extraPaths ?? []) written.set(`${dir}/${p}`, 'x');
    },
    async readBytes(file) {
      reads.push(file);
      if (archive !== undefined) {
        const rel = Object.keys(archive).find((p) => file.endsWith(`/${p}`));
        return rel === undefined ? new Uint8Array() : (archive[rel] as Uint8Array);
      }
      if (file.endsWith('libmpv-2.dll')) return opts.dll ?? LGPL;
      return new Uint8Array();
    },
    exists: (p) => written.has(p) || (opts.cached === true && p.endsWith('.zip')),
    async buildLauncher(dir) {
      builds.push(dir);
      written.set(`${dir}/elv-mpv.exe`, 'exe');
    },
    launcherSourceHash: async () => opts.launcherHash ?? null,
    log: (l) => logs.push(l),
    async readText(file) {
      const v = written.get(file);
      if (v === undefined) throw new Error('missing');
      return v;
    },
    async writeText(file, text) {
      written.set(file, text);
    },
    async installDir(from, to) {
      for (const [k, v] of [...written])
        if (k.startsWith(`${from}/`)) written.set(k.replace(from, to), v);
    },
    async listFiles(dir) {
      return [...written.keys()]
        .filter((k) => k.startsWith(`${dir}/`))
        .map((k) => k.slice(dir.length + 1));
    },
    async rename(from, to) {
      const v = written.get(from);
      if (v === undefined) throw new Error('missing');
      written.delete(from);
      written.set(to, v);
    },
    async findSymlinks() {
      return opts.symlinks ?? [];
    },
    async removeDir(dir) {
      events.push(`remove ${dir}`);
      written.delete(dir);
      for (const k of [...written.keys()]) if (k.startsWith(`${dir}/`)) written.delete(k);
    },
  };
  return { deps, written, downloads, downloadedTo, logs, extractedTo, builds, events, reads };
}

const base = { root: '/repo', platform: 'win32', arch: 'x64' };

describe('fetchRuntime', () => {
  it('skips a platform without a lock entry', async () => {
    const f = fake();
    const r = await fetchRuntime({ ...base, platform: 'linux', lock: LOCK }, f.deps);
    expect(r).toEqual({ status: 'unsupported', key: 'linux-x64' });
  });

  it('is current when BUILDINFO matches', async () => {
    const dir = '/repo/apps/desktop/resources/mpv/win32-x64';
    const info = JSON.stringify({
      sha256: HASH,
      licence: { ffmpegConfig: 'c', mpvOptions: 'o', lua: true },
    });
    const f = fake({ files: { [`${dir}/BUILDINFO.json`]: info } });
    const r = await fetchRuntime({ ...base, lock: LOCK }, f.deps);
    expect(r.status).toBe('current');
    expect(f.downloads).toEqual([]);
  });

  it('refuses a SHA-256 mismatch and installs nothing', async () => {
    const f = fake({ hash: 'b'.repeat(64) });
    await expect(fetchRuntime({ ...base, lock: LOCK }, f.deps)).rejects.toThrow(/SHA-256/);
    expect(f.extractedTo).toEqual([]);
    expect([...f.written.keys()].some((k) => k.includes('resources/mpv/win32-x64'))).toBe(false);
  });

  it('refuses a GPL binary and installs nothing', async () => {
    const f = fake({ dll: GPL });
    await expect(fetchRuntime({ ...base, lock: LOCK }, f.deps)).rejects.toThrow(/--enable-gpl/);
    expect([...f.written.keys()].some((k) => k.includes('resources/mpv/win32-x64'))).toBe(false);
  });

  it('installs libmpv-2.dll, LICENSE.LGPL, include/mpv/client.h and BUILDINFO for win32-x64', async () => {
    const f = fake();
    const r = await fetchRuntime({ ...base, lock: LOCK }, f.deps);
    expect(r.status).toBe('installed');
    const dir = '/repo/apps/desktop/resources/mpv/win32-x64';
    for (const p of ['libmpv-2.dll', 'LICENSE.LGPL', 'include/mpv/client.h', 'BUILDINFO.json']) {
      expect(f.written.has(`${dir}/${p}`), p).toBe(true);
    }
    const info = JSON.parse(f.written.get(`${dir}/BUILDINFO.json`) ?? '{}');
    expect(info.sha256).toBe(HASH);
    expect(info.licence.lua).toBe(true);
    expect(f.logs.at(-1)).toBe(
      'mpv: win32-x64 installed (mpv 0.42.0; ffmpeg without gpl/nonfree; mpv gpl=false; lua yes)',
    );
  });

  it('uses a cached file with the locked hash without downloading', async () => {
    const f = fake({ cached: true });
    const r = await fetchRuntime({ ...base, lock: LOCK }, f.deps);
    expect(r.status).toBe('installed');
    expect(f.downloads).toEqual([]);
  });

  it('deletes a downloaded file whose SHA-256 mismatches', async () => {
    const f = fake({ hash: 'b'.repeat(64) });
    await expect(fetchRuntime({ ...base, lock: LOCK }, f.deps)).rejects.toThrow(/SHA-256/);
    expect(
      [...f.written.keys()].filter((k) => k.includes('.cache/mpv') && k.includes('x.zip')),
    ).toEqual([]);
  });

  it('downloads to a temporary name first', async () => {
    const f = fake();
    await fetchRuntime({ ...base, lock: LOCK }, f.deps);
    expect(f.downloadedTo[0]).toMatch(/x\.zip\.part$/);
  });

  it.each(['../evil.dll', 'a/../../evil.dll', '/etc/passwd', 'C:/Windows/evil.dll', 'a\\..\\b'])(
    'refuses a hostile entry %s and removes the staging folder',
    async (path) => {
      const f = fake({ extraPaths: [path] });
      await expect(fetchRuntime({ ...base, lock: LOCK }, f.deps)).rejects.toThrow(/outside|unsafe/);
      expect([...f.written.keys()].some((k) => k.includes('staging-win32-x64/'))).toBe(false);
      expect([...f.written.keys()].some((k) => k.includes('resources/mpv/win32-x64'))).toBe(false);
    },
  );

  it('refuses a symlink in the archive', async () => {
    const f = fake({ symlinks: ['libmpv-link.dll'] });
    await expect(fetchRuntime({ ...base, lock: LOCK }, f.deps)).rejects.toThrow(/symlink/);
    expect([...f.written.keys()].some((k) => k.includes('resources/mpv/win32-x64'))).toBe(false);
  });
});

describe('fetchRuntime launcher stamp', () => {
  const dir = '/repo/apps/desktop/resources/mpv/win32-x64';
  const info = JSON.stringify({
    sha256: HASH,
    licence: { ffmpegConfig: 'c', mpvOptions: 'o', lua: true },
  });
  const exe = `${dir}/elv-mpv.exe`;
  const stamp = `${dir}/elv-mpv.stamp`;
  const current = (extra: Record<string, string>): Record<string, string> => ({
    [`${dir}/BUILDINFO.json`]: info,
    [exe]: 'exe',
    ...extra,
  });

  it('stamps the launcher with its source hash after an install', async () => {
    const f = fake({ launcherHash: 'src1' });
    await fetchRuntime({ ...base, lock: LOCK }, f.deps);
    expect(f.builds).toEqual([dir]);
    expect(f.written.get(stamp)).toBe('src1\n');
  });

  it('rebuilds the launcher of a current runtime when the stamp is missing or differs', async () => {
    for (const files of [current({}), current({ [stamp]: 'old\n' })]) {
      const f = fake({ files, launcherHash: 'src2' });
      const r = await fetchRuntime({ ...base, lock: LOCK }, f.deps);
      expect(r.status).toBe('current');
      expect(f.downloads).toEqual([]);
      expect(f.builds).toEqual([dir]);
      expect(f.written.get(stamp)).toBe('src2\n');
      expect(f.logs).toContain(
        'mpv: win32-x64 elv-mpv.exe is out of date with launcher sources; rebuilding',
      );
    }
  });

  it('rebuilds a missing launcher even when the stamp matches', async () => {
    const files = current({ [stamp]: 'src3\n' });
    delete files[exe];
    const f = fake({ files, launcherHash: 'src3' });
    await fetchRuntime({ ...base, lock: LOCK }, f.deps);
    expect(f.builds).toEqual([dir]);
  });

  it('keeps a launcher whose stamp matches, and builds nothing where there is no launcher', async () => {
    const stamped = fake({ files: current({ [stamp]: 'src4\n' }), launcherHash: 'src4' });
    await fetchRuntime({ ...base, lock: LOCK }, stamped.deps);
    expect(stamped.builds).toEqual([]);
    const none = fake({ files: current({}), launcherHash: null });
    await fetchRuntime({ ...base, lock: LOCK }, none.deps);
    expect(none.builds).toEqual([]);
    expect(none.written.has(stamp)).toBe(false);
  });
});

describe('fetchRuntime on darwin-arm64', () => {
  const MAC_LOCK = parseLock({
    'darwin-arm64': {
      kind: 'workflow-artifact',
      mpv: '0.42.0',
      repo: 'fatihmutluu/elv-iptv',
      runId: 123,
      artifact: 'mpv-runtime-darwin-arm64',
      file: 'mpv-runtime-darwin-arm64.tar.gz',
      sha256: HASH,
    },
  });
  const mac = { root: '/repo', platform: 'darwin', arch: 'arm64', lock: MAC_LOCK };
  const cache = '/repo/.cache/mpv/darwin-arm64';
  const tar = `${cache}/mpv-runtime-darwin-arm64.tar.gz`;
  const staging = '/repo/.cache/mpv/staging-darwin-arm64';
  const app = 'ELV IPTV Player.app/Contents';
  const bundle = (over: Record<string, Uint8Array> = {}): Record<string, Uint8Array> => ({
    [`${app}/MacOS/mpv`]: MPV,
    [`${app}/Frameworks/libavcodec.62.dylib`]: FFMPEG,
    [`${app}/Frameworks/libavformat.62.dylib`]: FFMPEG,
    [`${app}/Frameworks/libavutil.60.dylib`]: FFMPEG,
    [`${app}/Frameworks/libass.9.dylib`]: new Uint8Array(),
    [`${app}/Frameworks/libplacebo.387.dylib`]: new Uint8Array(),
    [`${app}/Info.plist`]: new Uint8Array(),
    ...over,
  });

  it('darwin fetch uses gh run download and verifies the tar hash', async () => {
    const f = fake({ archive: bundle() });
    const r = await fetchRuntime(mac, f.deps);
    expect(r.status).toBe('installed');
    expect(f.downloads).toEqual([]);
    const gh = `gh fatihmutluu/elv-iptv 123 mpv-runtime-darwin-arm64 ${cache}`;
    expect(f.events.filter((e) => !e.startsWith('remove'))).toEqual([
      gh,
      `sha256 ${tar}`,
      `extract ${tar} ${staging}`,
    ]);

    const bad = fake({ archive: bundle(), hash: 'b'.repeat(64) });
    await expect(fetchRuntime(mac, bad.deps)).rejects.toThrow(
      /SHA-256 mismatch for mpv-runtime-darwin-arm64\.tar\.gz/,
    );
    expect(bad.extractedTo).toEqual([]);
    expect(bad.written.has(tar)).toBe(false);

    const stale = fake({
      archive: bundle(),
      files: { [tar]: 'old' },
      hashes: ['c'.repeat(64), HASH],
    });
    await fetchRuntime(mac, stale.deps);
    expect(stale.events.slice(0, 3)).toEqual([`sha256 ${tar}`, `remove ${tar}`, gh]);
  });

  it('darwin fetch scans the dylibs and the binary', async () => {
    const f = fake({ archive: bundle() });
    await fetchRuntime(mac, f.deps);
    expect([...f.reads].sort()).toEqual(
      [
        `${app}/Frameworks/libavcodec.62.dylib`,
        `${app}/Frameworks/libavformat.62.dylib`,
        `${app}/Frameworks/libavutil.60.dylib`,
        `${app}/MacOS/mpv`,
      ].map((p) => `${staging}/${p}`),
    );
    const dir = '/repo/apps/desktop/resources/mpv/darwin-arm64';
    expect(f.written.has(`${dir}/${app}/MacOS/mpv`)).toBe(true);
    expect(f.logs.at(-1)).toBe(
      'mpv: darwin-arm64 installed (mpv 0.42.0; ffmpeg without gpl/nonfree; mpv gpl=false; lua yes)',
    );

    const gpl = fake({
      archive: bundle({ [`${app}/Frameworks/libavformat.62.dylib`]: GPL }),
    });
    await expect(fetchRuntime(mac, gpl.deps)).rejects.toThrow(
      /libavformat\.62\.dylib.*--enable-gpl/,
    );
    expect([...gpl.written.keys()].some((k) => k.startsWith(dir))).toBe(false);
  });

  it('darwin fetch scans libmpv.2.dylib and rejects GPL mpv options in it', async () => {
    const libmpvPath = `${app}/Frameworks/libmpv.2.dylib`;
    const ok = fake({
      archive: bundle({ [libmpvPath]: enc('-Dgpl=false -Dlibmpv=true -Dlua=luajit') }),
    });
    expect((await fetchRuntime(mac, ok.deps)).status).toBe('installed');
    expect(ok.reads).toContain(`${staging}/${libmpvPath}`);
    const gplLibmpv = fake({
      archive: bundle({ [libmpvPath]: enc('-Dgpl=true -Dlibmpv=true -Dlua=luajit') }),
    });
    await expect(fetchRuntime(mac, gplLibmpv.deps)).rejects.toThrow(
      /libmpv\.2\.dylib.*-Dgpl=false/,
    );
  });

  it('stamps and refreshes darwin elv-mpv and elv-iosurface.node outputs', async () => {
    const dir = '/repo/apps/desktop/resources/mpv/darwin-arm64';
    const info = JSON.stringify({
      sha256: HASH,
      licence: { ffmpegConfig: 'c', mpvOptions: 'o', lua: true },
    });
    const macExe = `${dir}/${app}/MacOS/elv-mpv`;
    const addon = `${dir}/elv-iosurface.node`;
    const mediaAddon = `${dir}/elv-macos-media.node`;
    const stamp = `${dir}/elv-mpv.stamp`;
    const baseFiles = (extra: Record<string, string> = {}): Record<string, string> => ({
      [`${dir}/BUILDINFO.json`]: info,
      [macExe]: 'exe',
      [addon]: 'node',
      [mediaAddon]: 'node',
      ...extra,
    });

    const fresh = fake({ archive: bundle(), launcherHash: 'mac1' });
    await fetchRuntime(mac, fresh.deps);
    expect(fresh.builds).toEqual([dir]);
    expect(fresh.written.get(stamp)).toBe('mac1\n');

    const ok = fake({ files: baseFiles({ [stamp]: 'mac2\n' }), launcherHash: 'mac2' });
    await fetchRuntime(mac, ok.deps);
    expect(ok.builds).toEqual([]);

    const missingExe = baseFiles({ [stamp]: 'mac2\n' });
    delete missingExe[macExe];
    const missingAddon = baseFiles({ [stamp]: 'mac2\n' });
    delete missingAddon[addon];
    const missingMediaAddon = baseFiles({ [stamp]: 'mac2\n' });
    delete missingMediaAddon[mediaAddon];
    for (const files of [
      baseFiles({}),
      baseFiles({ [stamp]: 'old\n' }),
      missingExe,
      missingAddon,
      missingMediaAddon,
    ]) {
      const f = fake({ files, launcherHash: 'mac2' });
      const r = await fetchRuntime(mac, f.deps);
      expect(r.status).toBe('current');
      expect(f.builds).toEqual([dir]);
      expect(f.written.get(stamp)).toBe('mac2\n');
      expect(f.logs).toContain(
        'mpv: darwin-arm64 elv-mpv is out of date with launcher sources; rebuilding',
      );
    }
  });
});

describe('verifyDirectory', () => {
  const out = '/tmp/out/darwin-arm64';
  const app = `${out}/ELV IPTV Player.app/Contents`;
  const files = { [`${app}/MacOS/mpv`]: 'bin', [`${app}/Frameworks/libavutil.60.dylib`]: 'bin' };

  it('applies the licence gate to a build folder without a lock entry', async () => {
    const ok = fake({ files });
    ok.deps.readBytes = async (file) => (file.endsWith('/mpv') ? MPV : FFMPEG);
    const v = await verifyDirectory(out, ok.deps);
    expect(v.lua).toBe(true);
    expect(ok.logs.at(-1)).toBe(
      `mpv: ${out} passed the licence gate (ffmpeg without gpl/nonfree; mpv gpl=false; lua yes)`,
    );

    const bad = fake({ files });
    bad.deps.readBytes = async () => GPL;
    await expect(verifyDirectory(out, bad.deps)).rejects.toThrow(/refused by the licence gate/);
  });
});

describe('verifyRuntime', () => {
  const dir = '/repo/apps/desktop/resources/mpv/win32-x64';
  it('refuses an install whose BUILDINFO hash differs from the lock', async () => {
    const f = fake({
      files: {
        [`${dir}/BUILDINFO.json`]: JSON.stringify({ sha256: 'c'.repeat(64) }),
        [`${dir}/libmpv-2.dll`]: 'dll',
      },
    });
    await expect(verifyRuntime({ ...base, lock: LOCK }, f.deps)).rejects.toThrow(
      /does not match the lock/,
    );
  });
});

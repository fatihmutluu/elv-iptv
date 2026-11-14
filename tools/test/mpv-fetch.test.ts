import { describe, expect, it } from 'vitest';
import { type FetchDeps, fetchRuntime } from '../src/mpv/fetch.ts';
import { parseLock } from '../src/mpv/lock.ts';

const HASH = 'a'.repeat(64);
const LOCK = parseLock({
  'win32-x64': {
    kind: 'upstream-libmpv',
    mpv: '0.42.0',
    url: 'https://example.org/x.zip',
    sha256: HASH,
  },
});
const enc = (s: string): Uint8Array => new TextEncoder().encode(`\u0000${s}\u0000`);
const LGPL = enc(
  '--prefix=/x --enable-version3 --disable-libx264 --disable-librubberband\u0000-Dgpl=false -Dlua=luajit',
);
const GPL = enc('--prefix=/x --enable-gpl --enable-version3 --disable-a\u0000-Dgpl=false');

interface Fake {
  deps: FetchDeps;
  written: Map<string, string>;
  downloads: string[];
  logs: string[];
  extractedTo: string[];
}

function fake(
  opts: { hash?: string; dll?: Uint8Array; files?: Record<string, string>; cached?: boolean } = {},
): Fake {
  const written = new Map<string, string>(Object.entries(opts.files ?? {}));
  const downloads: string[] = [];
  const logs: string[] = [];
  const extractedTo: string[] = [];
  const deps: FetchDeps = {
    async download(url, file) {
      downloads.push(url);
      written.set(file, 'archive');
    },
    async ghArtifact() {
      throw new Error('unused');
    },
    async sha256() {
      return opts.hash ?? HASH;
    },
    async extract(_archive, dir) {
      extractedTo.push(dir);
      written.set(`${dir}/libmpv-2.dll`, 'dll');
      written.set(`${dir}/LICENSE.LGPL`, 'lic');
      written.set(`${dir}/include/mpv/client.h`, 'h');
    },
    async readBytes(file) {
      if (file.endsWith('libmpv-2.dll')) return opts.dll ?? LGPL;
      return new Uint8Array();
    },
    exists: (p) => written.has(p) || (opts.cached === true && p.endsWith('.zip')),
    async buildLauncher() {},
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
    async removeDir(dir) {
      for (const k of [...written.keys()]) if (k.startsWith(`${dir}/`)) written.delete(k);
    },
  };
  return { deps, written, downloads, logs, extractedTo };
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
});

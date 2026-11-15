import { describe, expect, it } from 'vitest';
import { scanLicence } from '../src/mpv/licence.ts';

const bytes = (...parts: string[]): Uint8Array =>
  new TextEncoder().encode(`\u0000\u0001${parts.join('\u0000\u0002')}\u0000`);
const LGPL = '--prefix=/x --enable-version3 --disable-libx264 --disable-librubberband';

describe('mpv licence scan', () => {
  it('accepts an LGPL configuration', () => {
    const v = scanLicence([
      { name: 'libmpv-2.dll', bytes: bytes(LGPL, '-Dgpl=false -Dlua=luajit') },
    ]);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.lua).toBe(true);
    expect(v.ffmpegConfig).toContain('--enable-version3');
    expect(v.mpvOptions).toContain('-Dgpl=false');
  });

  it('rejects --enable-gpl', () => {
    const v = scanLicence([{ name: 'a', bytes: bytes(`${LGPL} --enable-gpl`, '-Dgpl=false') }]);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain('--enable-gpl');
  });

  it('rejects --enable-nonfree', () => {
    const v = scanLicence([{ name: 'a', bytes: bytes(`${LGPL} --enable-nonfree`, '-Dgpl=false') }]);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain('--enable-nonfree');
  });

  it('rejects -Dgpl=true', () => {
    const v = scanLicence([{ name: 'a', bytes: bytes(LGPL, '-Dgpl=true') }]);
    expect(v.ok).toBe(false);
  });

  it('rejects a runtime without an FFmpeg configuration', () => {
    const v = scanLicence([{ name: 'a', bytes: bytes('-Dgpl=false') }]);
    expect(v.ok).toBe(false);
    expect(v.ffmpegConfig).toBeNull();
  });

  it('rejects a runtime without mpv options', () => {
    const v = scanLicence([{ name: 'a', bytes: bytes(LGPL) }]);
    expect(v.ok).toBe(false);
    expect(v.mpvOptions).toBeNull();
  });

  it('reports lua false for -Dlua=disabled', () => {
    const v = scanLicence([{ name: 'a', bytes: bytes(LGPL, '-Dgpl=false -Dlua=disabled') }]);
    expect(v.ok).toBe(true);
    expect(v.lua).toBe(false);
  });
});

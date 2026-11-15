import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanLicence } from '../src/ffmpeg-media3/licence.ts';
import { buildSyntheticElf, populateValidBundle } from './ffmpeg-media3-helpers.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-ffmpeg-media3-lic-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('ffmpeg-media3 licence and bundle gate', () => {
  it('passes on a complete LGPL-2.1+ 16 KB bundle', () => {
    const dir = makeTempDir();
    populateValidBundle(dir);
    expect(scanLicence(dir)).toEqual({ ok: true, findings: [] });
  });

  it('fails cleanly when the target directory does not exist', () => {
    const res = scanLicence(join(tmpdir(), 'non-existent-ffmpeg-media3-dir-99999'));
    expect(res.ok).toBe(false);
  });

  it.each([
    '--enable-gpl',
    '--enable-nonfree',
    '--enable-version3',
    '--enable-static',
    'libavcodec license: GPL version 2 or later',
    'libavcodec license: GPL version 3 or later',
    'libavcodec license: LGPL version 3 or later',
    'libavcodec license: nonfree and unredistributable',
    'libx264',
    'libx265',
    'libfdk-aac',
  ])('fails when a binary embeds forbidden token %s', (forbidden) => {
    const dir = makeTempDir();
    populateValidBundle(dir, forbidden);
    const res = scanLicence(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.length).toBeGreaterThan(0);
  });

  it('fails when an ABI configure marker or --enable-shared is missing', () => {
    const dir = makeTempDir();
    populateValidBundle(dir);
    writeFileSync(
      join(dir, 'jniLibs/x86_64/libavcodec.so'),
      buildSyntheticElf({
        elfClass: 64,
        machine: 62,
        soname: 'libavcodec.so',
        needed: ['libswresample.so', 'libavutil.so', 'libc.so'],
        extraText: 'no-configure-marker-here',
      }),
    );
    const res = scanLicence(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.includes('x86_64'))).toBe(true);
  });

  it('fails when required Java/notice files are missing, mismatched, or video stub is present', () => {
    const dir = makeTempDir();
    populateValidBundle(dir);
    unlinkSync(join(dir, 'assets/licenses/ffmpeg-media3/ffmpeg/COPYING.LGPLv2.1'));
    writeFileSync(
      join(dir, 'assets/licenses/ffmpeg-media3/BUILDINFO.json'),
      '{"different":true}\n',
    );
    writeFileSync(
      join(dir, 'java/androidx/media3/decoder/ffmpeg/ExperimentalFfmpegVideoRenderer.java'),
      'class ExperimentalFfmpegVideoRenderer {}\n',
    );
    writeFileSync(join(dir, 'jniLibs/arm64-v8a/libavcodec.a'), 'static archive');
    writeFileSync(join(dir, 'jniLibs/arm64-v8a/libextra.so'), 'extra so');
    const res = scanLicence(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.includes('COPYING.LGPLv2.1'))).toBe(true);
    expect(res.findings.some((f) => f.includes('BUILDINFO.json'))).toBe(true);
    expect(res.findings.some((f) => f.includes('ExperimentalFfmpegVideoRenderer'))).toBe(true);
    expect(res.findings.some((f) => f.includes('libavcodec.a'))).toBe(true);
    expect(res.findings.some((f) => f.includes('libextra.so'))).toBe(true);
  });

  it('enforces a strict allowlist of the exact 23 bundle files (ignoring .ffmpeg-media3-sha256)', () => {
    const dir = makeTempDir();
    populateValidBundle(dir);
    writeFileSync(join(dir, '.ffmpeg-media3-sha256'), `${'a'.repeat(64)}\n`);
    expect(scanLicence(dir)).toEqual({ ok: true, findings: [] });

    writeFileSync(
      join(dir, 'java/androidx/media3/decoder/ffmpeg/SneakyInjected.java'),
      'package androidx.media3.decoder.ffmpeg;\nclass SneakyInjected {}\n',
    );
    writeFileSync(join(dir, 'extra.jar'), 'PK\x03\x04');
    const res = scanLicence(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.includes('SneakyInjected.java'))).toBe(true);
    expect(res.findings.some((f) => f.includes('extra.jar'))).toBe(true);
  });

  it('rejects symlinks inside the bundle when supported by the host OS', () => {
    const dir = makeTempDir();
    populateValidBundle(dir);
    try {
      symlinkSync(
        join(dir, 'jniLibs/arm64-v8a/libavcodec.so'),
        join(dir, 'jniLibs/arm64-v8a/libavcodec.so.61'),
      );
    } catch {
      return;
    }
    const res = scanLicence(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.includes('symlink'))).toBe(true);
  });
});

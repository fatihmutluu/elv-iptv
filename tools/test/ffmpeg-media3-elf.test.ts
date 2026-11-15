import { describe, expect, it } from 'vitest';
import {
  type FfmpegMedia3Abi,
  type FfmpegMedia3Library,
  parseElfSharedObject,
  verifyAbiLibrary,
} from '../src/ffmpeg-media3/elf.ts';
import { buildSyntheticElf } from './ffmpeg-media3-helpers.ts';

describe('ffmpeg-media3 ELF32/ELF64 inspector and 16 KB ABI verifier', () => {
  it('accepts valid 16 KB aligned libraries across arm64-v8a, armeabi-v7a and x86_64', () => {
    const cases: Array<[FfmpegMedia3Abi, 32 | 64, number]> = [
      ['arm64-v8a', 64, 183],
      ['armeabi-v7a', 32, 40],
      ['x86_64', 64, 62],
    ];
    const libs: Array<[FfmpegMedia3Library, string[]]> = [
      ['libavutil.so', ['libc.so', 'libm.so']],
      ['libswresample.so', ['libavutil.so', 'libc.so', 'libm.so']],
      ['libavcodec.so', ['libswresample.so', 'libavutil.so', 'libc.so', 'libm.so']],
      [
        'libffmpegJNI.so',
        ['libavcodec.so', 'libswresample.so', 'libavutil.so', 'liblog.so', 'libc.so'],
      ],
    ];
    for (const [abi, elfClass, machine] of cases) {
      for (const [lib, needed] of libs) {
        const bytes = buildSyntheticElf({ elfClass, machine, soname: lib, needed });
        expect(verifyAbiLibrary(abi, lib, bytes)).toEqual([]);
      }
    }
  });

  it('rejects 4 KB PT_LOAD alignment and incongruent vaddr/offset alignment', () => {
    const fourKb = buildSyntheticElf({
      soname: 'libavutil.so',
      needed: ['libc.so'],
      loadAligns: [{ offset: 0, vaddr: 0, align: 4096 }],
    });
    const findings4k = verifyAbiLibrary('arm64-v8a', 'libavutil.so', fourKb);
    expect(findings4k.some((f) => f.includes('16384'))).toBe(true);

    const incongruent = buildSyntheticElf({
      soname: 'libavutil.so',
      needed: ['libc.so'],
      loadAligns: [
        { offset: 0, vaddr: 0, align: 16384 },
        { offset: 0x1000, vaddr: 0x4000, align: 16384 },
      ],
    });
    const findingsCongruence = verifyAbiLibrary('arm64-v8a', 'libavutil.so', incongruent);
    expect(findingsCongruence.some((f) => f.includes('congruent'))).toBe(true);
  });

  it('rejects static FFmpeg linking when libffmpegJNI.so omits DT_NEEDED libavcodec.so', () => {
    const staticallyLinkedJni = buildSyntheticElf({
      soname: 'libffmpegJNI.so',
      needed: ['liblog.so', 'libc.so'],
    });
    const findings = verifyAbiLibrary('arm64-v8a', 'libffmpegJNI.so', staticallyLinkedJni);
    expect(findings.some((f) => f.includes('libavcodec.so'))).toBe(true);
    expect(findings.some((f) => f.includes('libswresample.so'))).toBe(true);
    expect(findings.some((f) => f.includes('libavutil.so'))).toBe(true);
  });

  it('rejects wrong ABI machine, versioned SONAME, disallowed DT_NEEDED, RPATH and TEXTREL', () => {
    const wrongArch = buildSyntheticElf({
      elfClass: 64,
      machine: 62,
      soname: 'libavutil.so',
      needed: ['libc.so'],
    });
    expect(verifyAbiLibrary('arm64-v8a', 'libavutil.so', wrongArch)).not.toEqual([]);

    const versionedSoname = buildSyntheticElf({
      soname: 'libavcodec.so.61',
      needed: ['libswresample.so', 'libavutil.so', 'libc.so'],
    });
    expect(
      verifyAbiLibrary('arm64-v8a', 'libavcodec.so', versionedSoname).some((f) =>
        f.includes('SONAME'),
      ),
    ).toBe(true);

    const disallowedDep = buildSyntheticElf({
      soname: 'libffmpegJNI.so',
      needed: ['libavcodec.so', 'libswresample.so', 'libavutil.so', 'libc++_shared.so'],
    });
    expect(
      verifyAbiLibrary('arm64-v8a', 'libffmpegJNI.so', disallowedDep).some((f) =>
        f.includes('libc++_shared.so'),
      ),
    ).toBe(true);

    const withRpath = buildSyntheticElf({
      soname: 'libavutil.so',
      needed: ['libc.so'],
      runpath: '/tmp/runner/lib',
    });
    expect(
      verifyAbiLibrary('arm64-v8a', 'libavutil.so', withRpath).some((f) => f.includes('RPATH')),
    ).toBe(true);

    const withTextRel = buildSyntheticElf({
      elfClass: 32,
      machine: 40,
      soname: 'libavutil.so',
      needed: ['libc.so'],
      flags: 0x4,
    });
    expect(
      verifyAbiLibrary('armeabi-v7a', 'libavutil.so', withTextRel).some((f) =>
        f.includes('TEXTREL'),
      ),
    ).toBe(true);
  });

  it('rejects truncated or non-ELF inputs cleanly', () => {
    expect(() => parseElfSharedObject(new Uint8Array([1, 2, 3]), 'tiny.so')).toThrow();
    const notDyn = buildSyntheticElf({ elfType: 2, soname: 'libavutil.so', needed: ['libc.so'] });
    expect(() => parseElfSharedObject(notDyn, 'exec.so')).toThrow(/ET_DYN/);
    expect(verifyAbiLibrary('arm64-v8a', 'libavutil.so', new Uint8Array([0, 1]))).not.toEqual([]);
  });
});

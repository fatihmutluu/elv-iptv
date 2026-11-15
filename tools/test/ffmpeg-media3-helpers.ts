import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FFMPEG_MEDIA3_ABIS,
  type FfmpegMedia3Abi,
  MIN_ANDROID_PAGE_ALIGN,
} from '../src/ffmpeg-media3/elf.ts';

export interface SyntheticElfOptions {
  elfClass?: 32 | 64;
  machine?: number;
  elfType?: number;
  soname?: string | null;
  needed?: string[];
  loadAligns?: Array<{
    offset: number;
    vaddr: number;
    align: number;
    filesz?: number;
    memsz?: number;
  }>;
  shoff?: number;
  shentsize?: number;
  shnum?: number;
  omitDtNull?: boolean;
  strszOverride?: number | null;
  unterminatedDynstr?: boolean;
  rpath?: string;
  runpath?: string;
  textRelTag?: boolean;
  flags?: number;
  extraText?: string;
}

/** Builds a minimal valid ELF32 or ELF64 little-endian shared object with PT_LOAD + PT_DYNAMIC. */
export function buildSyntheticElf(opts: SyntheticElfOptions = {}): Uint8Array {
  const elfClass = opts.elfClass ?? 64;
  const machine = opts.machine ?? (elfClass === 32 ? 40 : 183);
  const elfType = opts.elfType ?? 3;
  const soname = opts.soname === undefined ? 'libavcodec.so' : opts.soname;
  const needed = opts.needed ?? ['libswresample.so', 'libavutil.so', 'libc.so'];
  const loadSegments = opts.loadAligns ?? [
    { offset: 0, vaddr: 0, align: MIN_ANDROID_PAGE_ALIGN },
    { offset: 0x4000, vaddr: 0x4000, align: MIN_ANDROID_PAGE_ALIGN },
  ];

  const strings: string[] = [''];
  const addStr = (value: string): number => {
    let offset = 0;
    for (const s of strings) offset += Buffer.byteLength(s, 'utf8') + 1;
    strings.push(value);
    return offset;
  };
  const sonameOff = soname ? addStr(soname) : null;
  const neededOffs = needed.map(addStr);
  const rpathOff = opts.rpath ? addStr(opts.rpath) : null;
  const runpathOff = opts.runpath ? addStr(opts.runpath) : null;
  const dynstrBytes = Buffer.from(
    opts.unterminatedDynstr ? strings.join('\0') : `${strings.join('\0')}\0`,
    'utf8',
  );

  const dynOffset = 0x1000;
  const strtabOffset = 0x1800;
  const extraOffset = 0x2000;
  const extraBytes = Buffer.from(opts.extraText ?? '', 'latin1');
  const totalSize = Math.max(0x7000, extraOffset + extraBytes.length + 64);
  const buf = Buffer.alloc(totalSize, 0);

  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = elfClass === 32 ? 1 : 2;
  buf[5] = 1;
  buf[6] = 1;

  const dynEntries: Array<[number, number]> = [];
  if (sonameOff !== null) dynEntries.push([14, sonameOff]);
  for (const off of neededOffs) dynEntries.push([1, off]);
  dynEntries.push([5, strtabOffset]);
  if (opts.strszOverride !== null) {
    dynEntries.push([10, opts.strszOverride ?? dynstrBytes.length]);
  }
  if (rpathOff !== null) dynEntries.push([15, rpathOff]);
  if (runpathOff !== null) dynEntries.push([29, runpathOff]);
  if (opts.textRelTag) dynEntries.push([22, 0]);
  if (opts.flags !== undefined) dynEntries.push([30, opts.flags]);
  if (!opts.omitDtNull) dynEntries.push([0, 0]);

  dynstrBytes.copy(buf, strtabOffset);
  extraBytes.copy(buf, extraOffset);

  const phnum = loadSegments.length + 1;
  if (elfClass === 32) {
    const ehsize = 52;
    const phentsize = 32;
    const phoff = ehsize;
    buf.writeUInt16LE(elfType, 16);
    buf.writeUInt16LE(machine, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(phoff, 28);
    buf.writeUInt32LE(opts.shoff ?? 0, 32);
    buf.writeUInt16LE(ehsize, 40);
    buf.writeUInt16LE(phentsize, 42);
    buf.writeUInt16LE(phnum, 44);
    buf.writeUInt16LE(opts.shentsize ?? 0, 46);
    buf.writeUInt16LE(opts.shnum ?? 0, 48);

    let p = phoff;
    for (const seg of loadSegments) {
      const filesz = seg.filesz ?? 0x3000;
      const memsz = seg.memsz ?? filesz;
      buf.writeUInt32LE(1, p);
      buf.writeUInt32LE(seg.offset, p + 4);
      buf.writeUInt32LE(seg.vaddr, p + 8);
      buf.writeUInt32LE(filesz, p + 16);
      buf.writeUInt32LE(memsz, p + 20);
      buf.writeUInt32LE(5, p + 24);
      buf.writeUInt32LE(seg.align, p + 28);
      p += phentsize;
    }
    const dynBytes = dynEntries.length * 8;
    buf.writeUInt32LE(2, p);
    buf.writeUInt32LE(dynOffset, p + 4);
    buf.writeUInt32LE(dynOffset, p + 8);
    buf.writeUInt32LE(dynBytes, p + 16);
    buf.writeUInt32LE(dynBytes, p + 20);
    buf.writeUInt32LE(6, p + 24);
    buf.writeUInt32LE(8, p + 28);

    let d = dynOffset;
    for (const [tag, val] of dynEntries) {
      buf.writeInt32LE(tag, d);
      buf.writeUInt32LE(val, d + 4);
      d += 8;
    }
  } else {
    const ehsize = 64;
    const phentsize = 56;
    const phoff = ehsize;
    buf.writeUInt16LE(elfType, 16);
    buf.writeUInt16LE(machine, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeBigUInt64LE(BigInt(phoff), 32);
    buf.writeBigUInt64LE(BigInt(opts.shoff ?? 0), 40);
    buf.writeUInt16LE(ehsize, 52);
    buf.writeUInt16LE(phentsize, 54);
    buf.writeUInt16LE(phnum, 56);
    buf.writeUInt16LE(opts.shentsize ?? 0, 58);
    buf.writeUInt16LE(opts.shnum ?? 0, 60);

    let p = phoff;
    for (const seg of loadSegments) {
      const filesz = seg.filesz ?? 0x3000;
      const memsz = seg.memsz ?? filesz;
      buf.writeUInt32LE(1, p);
      buf.writeUInt32LE(5, p + 4);
      buf.writeBigUInt64LE(BigInt(seg.offset), p + 8);
      buf.writeBigUInt64LE(BigInt(seg.vaddr), p + 16);
      buf.writeBigUInt64LE(BigInt(filesz), p + 32);
      buf.writeBigUInt64LE(BigInt(memsz), p + 40);
      buf.writeBigUInt64LE(BigInt(seg.align), p + 48);
      p += phentsize;
    }
    const dynBytes = dynEntries.length * 16;
    buf.writeUInt32LE(2, p);
    buf.writeUInt32LE(6, p + 4);
    buf.writeBigUInt64LE(BigInt(dynOffset), p + 8);
    buf.writeBigUInt64LE(BigInt(dynOffset), p + 16);
    buf.writeBigUInt64LE(BigInt(dynBytes), p + 32);
    buf.writeBigUInt64LE(BigInt(dynBytes), p + 40);
    buf.writeBigUInt64LE(8n, p + 48);

    let d = dynOffset;
    for (const [tag, val] of dynEntries) {
      buf.writeBigInt64LE(BigInt(tag), d);
      buf.writeBigUInt64LE(BigInt(val), d + 8);
      d += 16;
    }
  }

  return new Uint8Array(buf);
}

function abiSpec(abi: FfmpegMedia3Abi): { elfClass: 32 | 64; machine: number } {
  if (abi === 'armeabi-v7a') return { elfClass: 32, machine: 40 };
  if (abi === 'x86_64') return { elfClass: 64, machine: 62 };
  return { elfClass: 64, machine: 183 };
}

/** Populates a complete valid vendor/ffmpeg-media3 directory for test mutation. */
export function populateValidBundle(root: string, extraCodecText = ''): void {
  const buildInfo = JSON.stringify(
    {
      ffmpegVersion: '9.0.2',
      media3Version: '1.11.1',
      ndkVersion: '28.2.13676358',
      abis: [...FFMPEG_MEDIA3_ABIS],
      configureByAbi: Object.fromEntries(
        FFMPEG_MEDIA3_ABIS.map((abi) => [
          abi,
          `--prefix=/elv-ffmpeg/${abi} --enable-shared --disable-static --disable-autodetect`,
        ]),
      ),
    },
    null,
    2,
  );

  mkdirSync(join(root, 'java/androidx/media3/decoder/ffmpeg'), { recursive: true });
  mkdirSync(join(root, 'assets/licenses/ffmpeg-media3/ffmpeg'), { recursive: true });
  mkdirSync(join(root, 'assets/licenses/ffmpeg-media3/media3'), { recursive: true });

  writeFileSync(join(root, 'BUILDINFO.json'), buildInfo);
  writeFileSync(
    join(root, 'proguard-rules.txt'),
    '-keep class androidx.media3.decoder.ffmpeg.**\n',
  );
  for (const file of [
    'FfmpegAudioDecoder.java',
    'FfmpegAudioRenderer.java',
    'FfmpegDecoderException.java',
    'FfmpegLibrary.java',
    'package-info.java',
  ]) {
    writeFileSync(
      join(root, 'java/androidx/media3/decoder/ffmpeg', file),
      `package androidx.media3.decoder.ffmpeg;\n// ${file}\n`,
    );
  }
  writeFileSync(join(root, 'assets/licenses/ffmpeg-media3/BUILDINFO.json'), buildInfo);
  writeFileSync(
    join(root, 'assets/licenses/ffmpeg-media3/ffmpeg/COPYING.LGPLv2.1'),
    'GNU LESSER GENERAL PUBLIC LICENSE Version 2.1\n',
  );
  writeFileSync(
    join(root, 'assets/licenses/ffmpeg-media3/ffmpeg/LICENSE.md'),
    'Most files in FFmpeg are under the GNU Lesser General Public License version 2.1.\n',
  );
  writeFileSync(
    join(root, 'assets/licenses/ffmpeg-media3/media3/LICENSE'),
    'Apache License Version 2.0\n',
  );

  for (const abi of FFMPEG_MEDIA3_ABIS) {
    const { elfClass, machine } = abiSpec(abi);
    const abiDir = join(root, 'jniLibs', abi);
    mkdirSync(abiDir, { recursive: true });
    const cfg = `--prefix=/elv-ffmpeg/${abi} --enable-shared --disable-static --disable-autodetect libavcodec license: LGPL version 2.1 or later ${extraCodecText}`;
    writeFileSync(
      join(abiDir, 'libavutil.so'),
      buildSyntheticElf({
        elfClass,
        machine,
        soname: 'libavutil.so',
        needed: ['libc.so'],
        extraText: cfg,
      }),
    );
    writeFileSync(
      join(abiDir, 'libswresample.so'),
      buildSyntheticElf({
        elfClass,
        machine,
        soname: 'libswresample.so',
        needed: ['libavutil.so', 'libc.so'],
        extraText: cfg,
      }),
    );
    writeFileSync(
      join(abiDir, 'libavcodec.so'),
      buildSyntheticElf({
        elfClass,
        machine,
        soname: 'libavcodec.so',
        needed: ['libswresample.so', 'libavutil.so', 'libc.so'],
        extraText: cfg,
      }),
    );
    writeFileSync(
      join(abiDir, 'libffmpegJNI.so'),
      buildSyntheticElf({
        elfClass,
        machine,
        soname: 'libffmpegJNI.so',
        needed: ['libavcodec.so', 'libswresample.so', 'libavutil.so', 'liblog.so', 'libc.so'],
      }),
    );
  }
}

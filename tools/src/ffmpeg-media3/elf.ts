/** Supported Android ABIs for the `@elv/engine-media3` FFmpeg bundle. */
export const FFMPEG_MEDIA3_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'] as const;

/** One of the supported Android ABIs. */
export type FfmpegMedia3Abi = (typeof FFMPEG_MEDIA3_ABIS)[number];

/** Shared libraries packaged per ABI in topological load order. */
export const FFMPEG_MEDIA3_LIBRARIES = [
  'libavutil.so',
  'libswresample.so',
  'libavcodec.so',
  'libffmpegJNI.so',
] as const;

/** One of the packaged `.so` file names. */
export type FfmpegMedia3Library = (typeof FFMPEG_MEDIA3_LIBRARIES)[number];

/** Android 15+ 16 KB ELF `PT_LOAD` minimum alignment. */
export const MIN_ANDROID_PAGE_ALIGN = 16_384;

/** Parsed `PT_LOAD` segment metadata. */
interface LoadSegmentInfo {
  offset: number;
  vaddr: number;
  align: number;
}

/** Summary extracted from an ELF32 or ELF64 shared library. */
export interface ElfInspection {
  elfClass: 32 | 64;
  machine: number;
  soname: string | null;
  needed: string[];
  loadSegments: LoadSegmentInfo[];
  hasRpath: boolean;
  hasTextRel: boolean;
}

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const ET_DYN = 3;

const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_SONAME = 14;
const DT_RPATH = 15;
const DT_TEXTREL = 22;
const DT_RUNPATH = 29;
const DT_FLAGS = 30;
const DF_TEXTREL = 0x4;

const EXPECTED_ARCH: Record<FfmpegMedia3Abi, { elfClass: 32 | 64; machine: number }> = {
  'arm64-v8a': { elfClass: 64, machine: 183 },
  'armeabi-v7a': { elfClass: 32, machine: 40 },
  x86_64: { elfClass: 64, machine: 62 },
};

const REQUIRED_NEEDED: Record<FfmpegMedia3Library, readonly string[]> = {
  'libavutil.so': [],
  'libswresample.so': ['libavutil.so'],
  'libavcodec.so': ['libavutil.so'],
  'libffmpegJNI.so': ['libavcodec.so', 'libswresample.so', 'libavutil.so'],
};

const ALLOWED_NEEDED = new Set<string>([
  'libavutil.so',
  'libswresample.so',
  'libavcodec.so',
  'libc.so',
  'libm.so',
  'libdl.so',
  'liblog.so',
  'libandroid.so',
]);

function readCString(bytes: Uint8Array, start: number, limit: number): string {
  if (start < 0 || start >= limit || start >= bytes.length) {
    throw new Error(`ELF dynamic string offset ${start} out of range`);
  }
  let end = start;
  const max = Math.min(limit, bytes.length);
  while (end < max && bytes[end] !== 0) end += 1;
  return Buffer.from(bytes.subarray(start, end)).toString('utf8');
}

function vaddrToFileOffset(
  vaddr: number,
  segments: Array<{ offset: number; vaddr: number; filesz: number }>,
): number | null {
  for (const seg of segments) {
    if (vaddr >= seg.vaddr && vaddr < seg.vaddr + seg.filesz) {
      return seg.offset + (vaddr - seg.vaddr);
    }
  }
  return null;
}

/** Parses ELF32/ELF64 little-endian `ET_DYN` headers, `PT_LOAD` segments and `PT_DYNAMIC` tags. */
export function parseElfSharedObject(bytes: Uint8Array, label: string): ElfInspection {
  if (bytes.length < 64) {
    throw new Error(`${label}: truncated ELF header (${bytes.length} bytes)`);
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error(`${label}: missing ELF magic`);
  }
  const classByte = bytes[4];
  if (classByte !== 1 && classByte !== 2) {
    throw new Error(`${label}: unsupported EI_CLASS ${String(classByte)}`);
  }
  const elfClass: 32 | 64 = classByte === 1 ? 32 : 64;
  if (bytes[5] !== 1) {
    throw new Error(`${label}: expected little-endian ELFDATA2LSB`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const elfType = view.getUint16(16, true);
  if (elfType !== ET_DYN) {
    throw new Error(`${label}: expected ET_DYN (3), got ${elfType}`);
  }
  const machine = view.getUint16(18, true);

  let phoff = 0;
  let phentsize = 0;
  let phnum = 0;
  if (elfClass === 32) {
    phoff = view.getUint32(28, true);
    phentsize = view.getUint16(42, true);
    phnum = view.getUint16(44, true);
    if (phentsize < 32) throw new Error(`${label}: invalid ELF32 phentsize ${phentsize}`);
  } else {
    phoff = Number(view.getBigUint64(32, true));
    phentsize = view.getUint16(54, true);
    phnum = view.getUint16(56, true);
    if (phentsize < 56) throw new Error(`${label}: invalid ELF64 phentsize ${phentsize}`);
  }
  if (phoff + phnum * phentsize > bytes.length) {
    throw new Error(`${label}: program header table exceeds file size`);
  }

  const loadSegments: LoadSegmentInfo[] = [];
  const loadRanges: Array<{ offset: number; vaddr: number; filesz: number }> = [];
  let dynOffset = -1;
  let dynSize = 0;

  for (let i = 0; i < phnum; i += 1) {
    const p = phoff + i * phentsize;
    const pType = view.getUint32(p, true);
    let offset = 0;
    let vaddr = 0;
    let filesz = 0;
    let align = 0;
    if (elfClass === 32) {
      offset = view.getUint32(p + 4, true);
      vaddr = view.getUint32(p + 8, true);
      filesz = view.getUint32(p + 16, true);
      align = view.getUint32(p + 28, true);
    } else {
      offset = Number(view.getBigUint64(p + 8, true));
      vaddr = Number(view.getBigUint64(p + 16, true));
      filesz = Number(view.getBigUint64(p + 32, true));
      align = Number(view.getBigUint64(p + 48, true));
    }
    if (pType === PT_LOAD) {
      loadSegments.push({ offset, vaddr, align });
      loadRanges.push({ offset, vaddr, filesz });
    } else if (pType === PT_DYNAMIC) {
      dynOffset = offset;
      dynSize = filesz;
    }
  }

  if (dynOffset < 0 || dynOffset + dynSize > bytes.length) {
    throw new Error(`${label}: missing or out-of-bounds PT_DYNAMIC segment`);
  }

  const entrySize = elfClass === 32 ? 8 : 16;
  const rawDyn: Array<[number, number]> = [];
  for (let off = dynOffset; off + entrySize <= dynOffset + dynSize; off += entrySize) {
    const tag = elfClass === 32 ? view.getInt32(off, true) : Number(view.getBigInt64(off, true));
    const val =
      elfClass === 32 ? view.getUint32(off + 4, true) : Number(view.getBigUint64(off + 8, true));
    if (tag === DT_NULL) break;
    rawDyn.push([tag, val]);
  }

  let strtabVaddr = -1;
  let strtabSize = 0;
  for (const [tag, val] of rawDyn) {
    if (tag === DT_STRTAB) strtabVaddr = val;
    if (tag === DT_STRSZ) strtabSize = val;
  }
  const strtabFileOffset = strtabVaddr >= 0 ? vaddrToFileOffset(strtabVaddr, loadRanges) : null;
  if (strtabFileOffset === null || strtabFileOffset + strtabSize > bytes.length) {
    throw new Error(`${label}: unable to map DT_STRTAB into file bounds`);
  }
  const strtabEnd = strtabSize > 0 ? strtabFileOffset + strtabSize : bytes.length;

  let soname: string | null = null;
  const needed: string[] = [];
  let hasRpath = false;
  let hasTextRel = false;

  for (const [tag, val] of rawDyn) {
    if (tag === DT_SONAME) {
      soname = readCString(bytes, strtabFileOffset + val, strtabEnd);
    } else if (tag === DT_NEEDED) {
      needed.push(readCString(bytes, strtabFileOffset + val, strtabEnd));
    } else if (tag === DT_RPATH || tag === DT_RUNPATH) {
      hasRpath = true;
    } else if (tag === DT_TEXTREL) {
      hasTextRel = true;
    } else if (tag === DT_FLAGS && (val & DF_TEXTREL) !== 0) {
      hasTextRel = true;
    }
  }

  return {
    elfClass,
    machine,
    soname,
    needed,
    loadSegments,
    hasRpath,
    hasTextRel,
  };
}

/** Verifies ABI architecture, 16 KB `PT_LOAD` alignment, unversioned SONAME and dynamic FFmpeg `DT_NEEDED` edges. */
export function verifyAbiLibrary(
  abi: FfmpegMedia3Abi,
  libName: FfmpegMedia3Library,
  bytes: Uint8Array,
): string[] {
  const label = `${abi}/${libName}`;
  let info: ElfInspection;
  try {
    info = parseElfSharedObject(bytes, label);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }

  const findings: string[] = [];
  const expected = EXPECTED_ARCH[abi];
  if (info.elfClass !== expected.elfClass || info.machine !== expected.machine) {
    findings.push(
      `${label}: expected ELF${expected.elfClass} machine ${expected.machine}, got ELF${info.elfClass} machine ${info.machine}`,
    );
  }

  if (info.loadSegments.length === 0) {
    findings.push(`${label}: has no PT_LOAD segments`);
  }
  for (let idx = 0; idx < info.loadSegments.length; idx += 1) {
    const seg = info.loadSegments[idx];
    if (!seg) continue;
    const isPow2 = seg.align > 0 && Math.trunc(Math.log2(seg.align)) === Math.log2(seg.align);
    if (!isPow2 || seg.align < MIN_ANDROID_PAGE_ALIGN) {
      findings.push(
        `${label}: PT_LOAD[${idx}] p_align=${seg.align} is below required ${MIN_ANDROID_PAGE_ALIGN} (16 KB)`,
      );
      continue;
    }
    const diff = (((seg.vaddr - seg.offset) % seg.align) + seg.align) % seg.align;
    if (diff !== 0) {
      findings.push(
        `${label}: PT_LOAD[${idx}] vaddr 0x${seg.vaddr.toString(16)} and offset 0x${seg.offset.toString(16)} are not congruent modulo ${seg.align}`,
      );
    }
  }

  if (info.soname !== libName) {
    findings.push(
      `${label}: expected unversioned DT_SONAME "${libName}", got ${info.soname === null ? 'none' : `"${info.soname}"`}`,
    );
  }

  for (const req of REQUIRED_NEEDED[libName]) {
    if (!info.needed.includes(req)) {
      findings.push(
        `${label}: missing dynamic DT_NEEDED "${req}" (static FFmpeg linking is forbidden)`,
      );
    }
  }
  for (const dep of info.needed) {
    if (!ALLOWED_NEEDED.has(dep)) {
      findings.push(`${label}: disallowed DT_NEEDED dependency "${dep}"`);
    }
  }

  if (info.hasRpath) {
    findings.push(`${label}: contains forbidden DT_RPATH or DT_RUNPATH`);
  }
  if (info.hasTextRel) {
    findings.push(`${label}: contains forbidden TEXTREL text relocations`);
  }

  return findings;
}

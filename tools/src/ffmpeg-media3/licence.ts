import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  FFMPEG_MEDIA3_ABIS,
  FFMPEG_MEDIA3_LIBRARIES,
  type FfmpegMedia3Library,
  verifyAbiLibrary,
} from './elf.ts';

/** Outcome of {@link scanLicence}. */
export interface LicenceCheckResult {
  ok: boolean;
  findings: string[];
}

const REQUIRED_FILES = [
  'BUILDINFO.json',
  'proguard-rules.txt',
  'java/androidx/media3/decoder/ffmpeg/FfmpegAudioDecoder.java',
  'java/androidx/media3/decoder/ffmpeg/FfmpegAudioRenderer.java',
  'java/androidx/media3/decoder/ffmpeg/FfmpegDecoderException.java',
  'java/androidx/media3/decoder/ffmpeg/FfmpegLibrary.java',
  'java/androidx/media3/decoder/ffmpeg/package-info.java',
  'assets/licenses/ffmpeg-media3/BUILDINFO.json',
  'assets/licenses/ffmpeg-media3/ffmpeg/COPYING.LGPLv2.1',
  'assets/licenses/ffmpeg-media3/ffmpeg/LICENSE.md',
  'assets/licenses/ffmpeg-media3/media3/LICENSE',
] as const;

const FORBIDDEN_FILES = [
  'java/androidx/media3/decoder/ffmpeg/ExperimentalFfmpegVideoRenderer.java',
] as const;

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: '--enable-gpl', regex: /--enable-gpl\b/ },
  { label: '--enable-nonfree', regex: /--enable-nonfree\b/ },
  { label: '--enable-version3', regex: /--enable-version3\b/ },
  { label: '--enable-static', regex: /--enable-static\b/ },
  { label: 'GPL version 2/3 licence string', regex: /\bGPL version [23]\b/ },
  { label: 'x264', regex: /\blibx264\b|\bx264\b/ },
  { label: 'x265', regex: /\blibx265\b|\bx265\b/ },
  { label: 'libfdk-aac', regex: /\blibfdk[-_]aac\b/ },
];

const EXPECTED_SO_PATHS = new Set<string>(
  FFMPEG_MEDIA3_ABIS.flatMap((abi) =>
    FFMPEG_MEDIA3_LIBRARIES.map((lib) => `jniLibs/${abi}/${lib}`),
  ),
);

const FFMPEG_OWNED_LIBS = new Set<FfmpegMedia3Library>([
  'libavutil.so',
  'libswresample.so',
  'libavcodec.so',
]);

function walkTree(
  rootDir: string,
  curDir: string,
  findings: string[],
  seenSoPaths: string[],
): void {
  for (const name of readdirSync(curDir)) {
    if (name === '.ffmpeg-media3-sha256') continue;
    const full = join(curDir, name);
    const rel = relative(rootDir, full).replace(/\\/g, '/');
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      findings.push(`${rel}: symlinks are forbidden in Android runtime bundles`);
      continue;
    }
    if (stat.isDirectory()) {
      walkTree(rootDir, full, findings, seenSoPaths);
      continue;
    }
    if (rel.endsWith('.a')) {
      findings.push(`${rel}: static archive (.a) is forbidden`);
    } else if (rel.endsWith('.so') || /\.so\.\d+/.test(rel)) {
      seenSoPaths.push(rel);
    }
  }
}

function scanTextForForbidden(rel: string, text: string, findings: string[]): void {
  for (const { label, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(text)) {
      findings.push(`${rel}: embeds forbidden ${label}`);
    }
  }
}

/**
 * Verifies file completeness, LGPL-2.1+ configure strings, absence of GPL/nonfree code,
 * dynamic FFmpeg `DT_NEEDED` edges and 16 KB ELF page alignment across all three Android ABIs.
 */
export function scanLicence(rootDir: string): LicenceCheckResult {
  if (!existsSync(rootDir)) {
    return { ok: false, findings: [`${rootDir}: bundle directory does not exist`] };
  }

  const findings: string[] = [];

  for (const rel of REQUIRED_FILES) {
    const full = join(rootDir, rel);
    if (!existsSync(full)) {
      findings.push(`${rel}: missing required file`);
      continue;
    }
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size === 0) {
      findings.push(`${rel}: required file is empty or not a regular file`);
    }
  }

  for (const rel of FORBIDDEN_FILES) {
    if (existsSync(join(rootDir, rel))) {
      findings.push(`${rel}: forbidden source file must not be packaged`);
    }
  }

  const buildInfoPath = join(rootDir, 'BUILDINFO.json');
  const assetBuildInfoPath = join(rootDir, 'assets/licenses/ffmpeg-media3/BUILDINFO.json');
  if (existsSync(buildInfoPath) && existsSync(assetBuildInfoPath)) {
    const rootJson = readFileSync(buildInfoPath, 'utf8');
    const assetJson = readFileSync(assetBuildInfoPath, 'utf8');
    if (rootJson !== assetJson) {
      findings.push(
        'assets/licenses/ffmpeg-media3/BUILDINFO.json: does not match top-level BUILDINFO.json',
      );
    }
    scanTextForForbidden('BUILDINFO.json', rootJson, findings);
  }

  const seenSoPaths: string[] = [];
  walkTree(rootDir, rootDir, findings, seenSoPaths);
  for (const soRel of seenSoPaths) {
    if (!EXPECTED_SO_PATHS.has(soRel)) {
      findings.push(`${soRel}: unexpected shared library in bundle`);
    }
  }

  for (const abi of FFMPEG_MEDIA3_ABIS) {
    const expectedPrefix = `--prefix=/elv-ffmpeg/${abi}`;
    for (const lib of FFMPEG_MEDIA3_LIBRARIES) {
      const rel = `jniLibs/${abi}/${lib}`;
      const full = join(rootDir, rel);
      if (!existsSync(full)) {
        findings.push(`${rel}: missing shared library`);
        continue;
      }
      const bytes = readFileSync(full);
      findings.push(...verifyAbiLibrary(abi, lib, bytes));

      const latin1 = bytes.toString('latin1');
      scanTextForForbidden(rel, latin1, findings);

      if (FFMPEG_OWNED_LIBS.has(lib)) {
        if (!latin1.includes(expectedPrefix)) {
          findings.push(`${rel}: missing embedded configure marker "${expectedPrefix}"`);
        }
        if (!latin1.includes('--enable-shared') || !latin1.includes('--disable-static')) {
          findings.push(`${rel}: missing "--enable-shared --disable-static" configure flags`);
        }
        if (!latin1.includes('LGPL version 2.1 or later')) {
          findings.push(`${rel}: missing "LGPL version 2.1 or later" licence banner`);
        }
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

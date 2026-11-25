import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLock } from '../src/mpv/lock.ts';
import { findRepoRoot } from '../src/root.ts';

const ROOT = findRepoRoot(import.meta.dirname);
const BUILD_SH = join(ROOT, 'tools/mpv-runtime/build-windows.sh');
const BUILD_PS1 = join(ROOT, 'tools/mpv-runtime/build-windows.ps1');
const WORKFLOW = join(ROOT, '.github/workflows/mpv-runtime.yml');

describe('Windows LGPL mpv CI build scripts and workflow (#94)', () => {
  it('ships build-windows.sh with strict LGPL, baseline x86-64, DLL walker, and smoke test', () => {
    expect(existsSync(BUILD_SH)).toBe(true);
    const sh = readFileSync(BUILD_SH, 'utf8');
    const activeLines = sh
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(activeLines).not.toMatch(/--enable-gpl(?![\w-])/);
    expect(activeLines).not.toMatch(/--enable-nonfree(?![\w-])/);

    for (const flag of [
      '--disable-gpl',
      '--disable-nonfree',
      '--enable-shared',
      '--disable-static',
      '--disable-programs',
      '--disable-doc',
      '--enable-d3d11va',
      '--enable-dxva2',
      '--enable-schannel',
      '-Dgpl=false',
      '-Dlibmpv=true',
      '-Dcplayer=false',
      '-Dlua=luajit',
      '-Dd3d11=enabled',
      '-Dgl=enabled',
      '-Drubberband=disabled',
      '-Ddvdnav=disabled',
      '-Dcdda=disabled',
      '-march=x86-64',
      '-mtune=generic',
    ]) {
      expect(activeLines, `missing flag ${flag}`).toContain(flag);
    }

    expect(activeLines).toContain('PKG_CONFIG_LIBDIR=');
    expect(activeLines).toContain('unset PKG_CONFIG_PATH');
    expect(activeLines).toContain('objdump -p');
    expect(activeLines).toContain('find "$out" -type l');
    expect(activeLines).toContain('RUNTIME-BUILDINFO.json');
    expect(activeLines).toContain('include/mpv');
    expect(activeLines).toContain('licenses/');
    expect(activeLines).toContain('LoadLibrary');
    expect(activeLines).toContain('mpv_client_api_version');
  });

  it('ships build-windows.ps1 wrapper locating MSYS2 mingw64 bash', () => {
    expect(existsSync(BUILD_PS1)).toBe(true);
    const ps1 = readFileSync(BUILD_PS1, 'utf8');
    expect(ps1).toContain('MINGW64');
    expect(ps1).toContain('build-windows.sh');
  });

  it('defines a pinned, zizmor-safe win32-x64 job in .github/workflows/mpv-runtime.yml', () => {
    const yml = readFileSync(WORKFLOW, 'utf8');

    expect(yml).toContain('win32-x64:');
    expect(yml).toContain('runs-on: windows-2025');
    expect(yml).toContain('msys2/setup-msys2@3c51bf698df1e37b2261f53cb67797b97761185c # v2.34.0');
    expect(yml).toContain('build-windows.sh');
    expect(yml).toContain('node tools/bin/mpv.ts verify --dir');
    expect(yml).toContain('mpv-runtime-win32-x64.tar.gz');
    expect(yml).toContain('name: mpv-runtime-win32-x64');
    expect(yml).toContain('retention-days: 90');

    // Every `uses:` action must be pinned to a full 40-char commit SHA.
    const usesMatches = [...yml.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1] ?? '');
    expect(usesMatches.length).toBeGreaterThanOrEqual(7);
    for (const ref of usesMatches) {
      expect(ref, `action not pinned to 40-char SHA: ${ref}`).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }

    // No `${{ ... }}` interpolation inside `run:` blocks.
    const lines = yml.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const runMatch = /^(\s*)run:\s*(.*)$/.exec(line);
      if (!runMatch) continue;
      const runIndent = (runMatch[1] ?? '').length;
      const inline = (runMatch[2] ?? '').trim();
      if (inline !== '|' && inline !== '>') {
        expect(inline).not.toContain('${{');
        continue;
      }
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? '';
        if (next.trim() === '') continue;
        const indent = next.length - next.trimStart().length;
        if (indent <= runIndent) break;
        expect(next).not.toContain('${{');
      }
    }
  });

  it('accepts the win32-x64 workflow-artifact lock shape emitted by mpv-runtime.yml', () => {
    const parsed = parseLock({
      'win32-x64': {
        kind: 'workflow-artifact',
        mpv: '0.42.0',
        repo: 'fatihmutluu/elv-iptv',
        runId: 123456789,
        artifact: 'mpv-runtime-win32-x64',
        file: 'mpv-runtime-win32-x64.tar.gz',
        sha256: 'a'.repeat(64),
      },
    });
    expect(parsed['win32-x64']).toMatchObject({
      kind: 'workflow-artifact',
      mpv: '0.42.0',
      artifact: 'mpv-runtime-win32-x64',
      file: 'mpv-runtime-win32-x64.tar.gz',
    });
  });

  it('documents all 8 pinned Windows & macOS mpv runtime libraries in notices-data.ts', () => {
    const notices = readFileSync(
      join(ROOT, 'packages/features/src/notices/notices-data.ts'),
      'utf8',
    );
    expect(notices).toContain("id: 'desktop-libmpv'");
    expect(notices).toContain("platforms: ['Windows', 'macOS']");
    expect(notices).toContain("license: 'LGPL-2.1-or-later AND ISC AND MIT AND FTL'");
    for (const token of [
      'build-windows.sh',
      'libmpv',
      'FFmpeg',
      'libass',
      'libplacebo',
      'FreeType',
      'HarfBuzz',
      'FriBidi',
      'LuaJIT',
    ]) {
      expect(notices, `missing ${token} in notices-data.ts`).toContain(token);
    }
  });
});

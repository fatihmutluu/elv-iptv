#!/usr/bin/env bash
# Builds the LGPL mpv runtime for Windows x64 inside MSYS2 MINGW64 from the sources pinned in
# versions.json and lays it out in <out>/: libmpv-2.dll + all transitive non-system DLLs,
# include/mpv/*.h, licenses/<lib>/, and RUNTIME-BUILDINFO.json.
# Usage: build-windows.sh <work dir> <out dir>.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: build-windows.sh <work dir> <out dir>" >&2
  exit 2
fi

if [ "${MSYSTEM:-}" != "MINGW64" ]; then
  echo "build-windows.sh must run inside MSYS2 MINGW64 (got MSYSTEM=${MSYSTEM:-unset})" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")" && pwd)"
versions="$here/versions.json"
mkdir -p "$1" "$2"
work="$(cd "$1" && pwd)"
out="$(cd "$2" && pwd)"
prefix="$work/prefix"
jobs="$(nproc)"

# Isolated prefix: never pick up stray MSYS2 libraries via pkg-config.
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
unset PKG_CONFIG_PATH

# Baseline x86_64 compatibility (no AVX2-only codegen).
BASE_FLAGS="-O2 -march=x86-64 -mtune=generic"
export CFLAGS="$BASE_FLAGS"
export CXXFLAGS="$BASE_FLAGS"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

pin() { jq -er --arg n "$1" --arg k "$2" '.[$n][$k]' "$versions" | tr -d '\r'; }

# Downloads a pinned tarball, refuses it unless its SHA-256 matches and unpacks it into $work/src/<name>.
unpack() {
  local name="$1" url sha file actual
  echo "==> $name $(pin "$name" version)"
  url="$(pin "$name" url)"
  sha="$(pin "$name" sha256)"
  file="$work/download/$name-$(basename "$url")"
  rm -rf "$work/src/$name"
  mkdir -p "$work/download" "$work/src/$name"
  curl -fsSL --retry 5 --retry-all-errors -o "$file" "$url"
  actual="$(sha256_file "$file")"
  if [ "$actual" != "$sha" ]; then
    echo "$name: SHA-256 mismatch for $url: expected $sha, got $actual" >&2
    exit 1
  fi
  tar -xf "$file" -C "$work/src/$name" --strip-components 1
}

# Clones a pinned tag with its submodules and refuses it unless the tag points at the pinned commit.
clone() {
  local name="$1" commit actual
  echo "==> $name $(pin "$name" version)"
  commit="$(pin "$name" commit)"
  rm -rf "$work/src/$name"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$(pin "$name" tag)" \
    --recurse-submodules "$(pin "$name" git)" "$work/src/$name"
  actual="$(git -C "$work/src/$name" rev-parse HEAD | tr -d '\r')"
  if [ "$actual" != "$commit" ]; then
    echo "$name: the tag points at $actual, expected $commit" >&2
    exit 1
  fi
}

# Replaces files of an unpacked source with their upstream version from a later commit (versions.json "backports");
# the file must match "sha256Before" and the download "sha256".
backport() {
  local name="$1" path url before after file
  while IFS=$'\t' read -r path url before after; do
    [ -z "$path" ] && continue
    file="$work/src/$name/$path"
    if [ "$(sha256_file "$file")" != "$before" ]; then
      echo "$name: $path is not the file the backport replaces" >&2
      exit 1
    fi
    curl -fsSL --retry 5 --retry-all-errors -o "$file" "$url"
    if [ "$(sha256_file "$file")" != "$after" ]; then
      echo "$name: SHA-256 mismatch for $url" >&2
      exit 1
    fi
    echo "$name: backported $path from $url"
  done < <(jq -r --arg n "$name" '.[$n].backports // [] | .[] | [.path, .url, .sha256Before, .sha256] | @tsv' "$versions" | tr -d '\r')
}

meson_build() {
  local name="$1"
  shift
  rm -rf "$work/build/$name"
  meson setup "$work/build/$name" "$work/src/$name" --prefix="$prefix" --libdir=lib --bindir=bin \
    --buildtype=release --default-library=shared --wrap-mode=nofallback "$@"
  meson compile -C "$work/build/$name" -j "$jobs"
  meson install -C "$work/build/$name" --quiet
}

ffmpeg_flags=(
  --prefix="$prefix"
  --enable-shared
  --disable-static
  --disable-programs
  --disable-doc
  --disable-gpl
  --disable-nonfree
  --disable-bzlib
  --disable-iconv
  --disable-lzma
  --enable-d3d11va
  --enable-dxva2
  --enable-schannel
  --extra-cflags="$BASE_FLAGS"
)
mpv_flags=(
  -Dgpl=false
  -Dlibmpv=true
  -Dcplayer=false
  -Dlua=luajit
  -Dd3d11=disabled
  -Dgl=enabled
  -Drubberband=disabled
  -Ddvdnav=disabled
  -Dcdda=disabled
  -Dtests=false
)

unpack fribidi
meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false

unpack freetype
meson_build freetype -Dharfbuzz=disabled -Dbrotli=disabled -Dbzip2=disabled -Dpng=disabled

unpack harfbuzz
meson_build harfbuzz -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled \
  -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled

unpack libass
meson_build libass -Dfontconfig=disabled -Ddirectwrite=enabled -Dasm=enabled

clone libplacebo
meson_build libplacebo -Dvulkan=disabled -Dopengl=enabled -Dd3d11=disabled \
  -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled -Dlibdovi=disabled \
  -Dxxhash=disabled -Ddemos=false

unpack luajit
make -C "$work/src/luajit/src" amalg BUILDMODE=dynamic TARGET_SYS=Windows \
  XCFLAGS="$BASE_FLAGS" -j"$jobs"
mkdir -p "$prefix/bin" "$prefix/lib/pkgconfig" "$prefix/include/luajit-2.1"
cp -L "$work/src/luajit/src/lua51.dll" "$prefix/bin/lua51.dll"
cp -L \
  "$work/src/luajit/src/lua.h" \
  "$work/src/luajit/src/lualib.h" \
  "$work/src/luajit/src/lauxlib.h" \
  "$work/src/luajit/src/luaconf.h" \
  "$work/src/luajit/src/lua.hpp" \
  "$work/src/luajit/src/luajit.h" \
  "$prefix/include/luajit-2.1/"
cat >"$prefix/lib/pkgconfig/luajit.pc" <<EOF
prefix=$prefix
exec_prefix=\${prefix}
libdir=\${prefix}/bin
includedir=\${prefix}/include/luajit-2.1

Name: LuaJIT
Description: Just-In-Time Compiler for Lua
URL: https://luajit.org
Version: 2.1.0-beta3
Libs: -L\${libdir} -llua51
Cflags: -I\${includedir}
EOF

unpack ffmpeg
rm -rf "$work/build/ffmpeg"
mkdir -p "$work/build/ffmpeg"
(cd "$work/build/ffmpeg" && "$work/src/ffmpeg/configure" "${ffmpeg_flags[@]}")
make -C "$work/build/ffmpeg" -j"$jobs"
make -C "$work/build/ffmpeg" install

unpack mpv
backport mpv
# mpv 0.42.0 compiles vf_d3d11vpp.c under d3d-hwaccel (win32) even when -Dd3d11=disabled, but only
# includes d3d11_helpers.c (and probes HAVE_DXGI_DEBUG_D3D11) when d3d11, ANGLE, or Vulkan is active.
awk -v target="if features['d3d11'] or features['egl-angle-win32'] or (features['vulkan'] and win32)" \
    -v suffix=" or (win32 and get_option('d3d-hwaccel').allowed())" '
  $0 == target { print $0 suffix; patched = 1; next }
  { print }
  END { if (!patched) exit 1 }
' "$work/src/mpv/meson.build" >"$work/src/mpv/meson.build.tmp"
mv "$work/src/mpv/meson.build.tmp" "$work/src/mpv/meson.build"
meson_build mpv "${mpv_flags[@]}"

echo "==> bundle"
rm -rf "$out"
mkdir -p "$out/include" "$out/licenses"

libmpv=""
for candidate in "$prefix/bin/libmpv-2.dll" "$prefix/lib/libmpv-2.dll"; do
  if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
    libmpv="$candidate"
    break
  fi
done
if [ -z "$libmpv" ]; then
  echo "libmpv-2.dll not found in $prefix/bin or $prefix/lib" >&2
  exit 1
fi
cp -L "$libmpv" "$out/libmpv-2.dll"
chmod 755 "$out/libmpv-2.dll"

cp -R -L "$prefix/include/mpv" "$out/include/mpv"
if [ ! -f "$out/include/mpv/client.h" ]; then
  echo "include/mpv/client.h not found after copy" >&2
  exit 1
fi

dll_deps() {
  objdump -p "$1" | tr -d '\r' | awk '/^[[:space:]]*DLL Name:/ { print $3 }'
}

is_windows_system_dll() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    api-ms-win-*.dll | ext-ms-win-*.dll) return 0 ;;
    advapi32.dll | avrt.dll | bcrypt.dll | bcryptprimitives.dll | cfgmgr32.dll | combase.dll | comctl32.dll | \
    comdlg32.dll | crypt32.dll | cryptbase.dll | d2d1.dll | d3d9.dll | d3d11.dll | \
    dbghelp.dll | dcomp.dll | dnsapi.dll | dwmapi.dll | dwrite.dll | dxgi.dll | dxva2.dll | \
    evr.dll | gdi32.dll | hid.dll | imm32.dll | iphlpapi.dll | kernel32.dll | kernelbase.dll | \
    ksuser.dll | mfplat.dll | mfuuid.dll | mmdevapi.dll | mpr.dll | msimg32.dll | msvcrt.dll | \
    mswsock.dll | ncrypt.dll | netapi32.dll | normaliz.dll | ntdll.dll | ole32.dll | \
    oleacc.dll | oleaut32.dll | opengl32.dll | pathcch.dll | powrprof.dll | propsys.dll | psapi.dll | \
    rpcrt4.dll | secur32.dll | setupapi.dll | shcore.dll | shell32.dll | shfolder.dll | \
    shlwapi.dll | sspicli.dll | strmiids.dll | ucrtbase.dll | user32.dll | userenv.dll | \
    usp10.dll | uxtheme.dll | version.dll | windowscodecs.dll | winhttp.dll | winmm.dll | \
    winspool.drv | wlanapi.dll | ws2_32.dll | wsock32.dll | wtsapi32.dll)
      return 0
      ;;
  esac
  return 1
}

find_dep_dll() {
  local dep="$1" dir match
  for dir in "$prefix/bin" "$prefix/lib" "/mingw64/bin"; do
    if [ -f "$dir/$dep" ]; then
      printf '%s\n' "$dir/$dep"
      return 0
    fi
    if [ -d "$dir" ]; then
      match="$(find "$dir" -maxdepth 1 -iname "$dep" -print -quit 2>/dev/null || true)"
      if [ -n "$match" ] && [ -f "$match" ]; then
        printf '%s\n' "$match"
        return 0
      fi
    fi
  done
  return 1
}

# Walk all transitive non-system DLLs starting from libmpv-2.dll.
todo="$work/dll-todo"
mingw_dlls="$work/mingw-dlls.txt"
printf '%s\n' "$out/libmpv-2.dll" >"$todo"
: >"$mingw_dlls"

fail=0
while [ -s "$todo" ]; do
  file="$(head -n 1 "$todo")"
  tail -n +2 "$todo" >"$todo.next"
  mv "$todo.next" "$todo"
  while read -r dep; do
    [ -z "$dep" ] && continue
    if is_windows_system_dll "$dep"; then
      continue
    fi
    if src="$(find_dep_dll "$dep")"; then
      dest_name="$(basename "$src")"
      dest="$out/$dest_name"
      if [ ! -e "$dest" ]; then
        cp -L "$src" "$dest"
        chmod 755 "$dest"
        printf '%s\n' "$dest" >>"$todo"
        case "$src" in
          /mingw64/bin/*) printf '%s\n' "$dest_name" >>"$mingw_dlls" ;;
        esac
      fi
    else
      echo "$file: unresolved non-system DLL dependency: $dep" >&2
      fail=1
    fi
  done < <(dll_deps "$file")
done

# Verify every bundled DLL resolves exclusively to bundled DLLs or Windows system DLLs, with zero symlinks.
for file in "$out"/*.dll; do
  while read -r dep; do
    [ -z "$dep" ] && continue
    if is_windows_system_dll "$dep"; then
      continue
    fi
    if [ -z "$(find "$out" -maxdepth 1 -iname "$dep" -type f -print -quit)" ]; then
      echo "$file: required DLL $dep is missing from bundle" >&2
      fail=1
    fi
  done < <(dll_deps "$file")
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

for name in fribidi freetype harfbuzz libass libplacebo luajit ffmpeg mpv; do
  mkdir -p "$out/licenses/$name"
  while read -r licence; do
    [ -z "$licence" ] && continue
    cp -L "$work/src/$name/$licence" "$out/licenses/$name/"
  done < <(jq -er --arg n "$name" '.[$n].licences[]' "$versions" | tr -d '\r')
done

if [ -s "$mingw_dlls" ]; then
  mkdir -p "$out/licenses/mingw-runtime"
  for pkg in winpthreads gcc-libs mingw-w64 zlib; do
    if [ -d "/mingw64/share/licenses/$pkg" ]; then
      cp -R -L "/mingw64/share/licenses/$pkg" "$out/licenses/mingw-runtime/$pkg"
    fi
  done
  {
    echo "Bundled MinGW-w64 / GCC toolchain runtime DLLs:"
    sort -u "$mingw_dlls" | sed 's/^/  - /'
    echo
    echo "These runtime support libraries are distributed under their respective upstream"
    echo "licenses (MinGW-w64 / winpthreads MIT/ZPL-2.1, GCC Runtime Library Exception 3.1,"
    echo "and Zlib license if zlib1.dll is present)."
  } >"$out/licenses/mingw-runtime/NOTICE.txt"
fi

compiler="$(gcc --version | head -n 1 | tr -d '\r')"
jq --arg target "win32-x64" \
  --arg compiler "$compiler" \
  --arg cflags "$BASE_FLAGS" \
  --arg ffmpeg "${ffmpeg_flags[*]:1}" \
  --arg mpv "${mpv_flags[*]}" \
  '{target: $target, compiler: $compiler, cflags: $cflags, configure: {ffmpeg: $ffmpeg, mpv: $mpv}, sources: del(.macosDeploymentTarget)}' \
  "$versions" >"$out/RUNTIME-BUILDINFO.json"

if [ -n "$(find "$out" -type l)" ]; then
  echo "the bundle contains symlinks" >&2
  exit 1
fi

echo "==> smoke test"
cat >"$work/smoke.c" <<'EOF'
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <mpv/client.h>

typedef unsigned long (*api_version_fn)(void);
typedef mpv_handle *(*create_fn)(void);
typedef int (*set_opt_fn)(mpv_handle *, const char *, const char *);
typedef int (*init_fn)(mpv_handle *);
typedef void (*destroy_fn)(mpv_handle *);

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: smoke <path-to-libmpv-2.dll>\n");
    return 2;
  }
  wchar_t wpath[MAX_PATH * 2];
  int n = MultiByteToWideChar(CP_UTF8, 0, argv[1], -1, wpath, (int)(sizeof(wpath) / sizeof(wpath[0])));
  if (n <= 0) {
    fprintf(stderr, "path conversion failed\n");
    return 2;
  }
  HMODULE lib = LoadLibraryExW(wpath, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!lib) {
    fprintf(stderr, "LoadLibraryExW failed with Win32 error %lu\n", GetLastError());
    return 3;
  }
  api_version_fn ver_fn = (api_version_fn)(void *)GetProcAddress(lib, "mpv_client_api_version");
  create_fn create = (create_fn)(void *)GetProcAddress(lib, "mpv_create");
  set_opt_fn set_opt = (set_opt_fn)(void *)GetProcAddress(lib, "mpv_set_option_string");
  init_fn init = (init_fn)(void *)GetProcAddress(lib, "mpv_initialize");
  destroy_fn destroy = (destroy_fn)(void *)GetProcAddress(lib, "mpv_terminate_destroy");
  if (!ver_fn || !create || !set_opt || !init || !destroy) {
    fprintf(stderr, "missing required libmpv export\n");
    FreeLibrary(lib);
    return 4;
  }
  unsigned long api = ver_fn();
  if (api == 0) {
    fprintf(stderr, "mpv_client_api_version returned 0\n");
    FreeLibrary(lib);
    return 5;
  }
  mpv_handle *h = create();
  if (!h) {
    fprintf(stderr, "mpv_create returned NULL\n");
    FreeLibrary(lib);
    return 6;
  }
  set_opt(h, "config", "no");
  set_opt(h, "vo", "null");
  set_opt(h, "ao", "null");
  if (init(h) < 0) {
    fprintf(stderr, "mpv_initialize failed\n");
    destroy(h);
    FreeLibrary(lib);
    return 7;
  }
  destroy(h);
  FreeLibrary(lib);
  printf("smoke ok: mpv_client_api_version=0x%lx\n", api);
  return 0;
}
EOF

gcc -O2 -Wall -Wextra -Werror -static-libgcc -I"$out/include" "$work/smoke.c" -o "$work/smoke.exe"
win_sys32="$(cygpath -u "${SYSTEMROOT:-C:/Windows}/System32")"
win_root="$(cygpath -u "${SYSTEMROOT:-C:/Windows}")"
win_dll="$(cygpath -w "$out/libmpv-2.dll")"
env -u PKG_CONFIG_PATH PATH="$win_sys32:$win_root" "$work/smoke.exe" "$win_dll"

ls -l "$out"/*.dll

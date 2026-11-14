#!/usr/bin/env bash
# Builds the LGPL mpv runtime for macOS arm64 from the sources pinned in versions.json and lays it out as
# <out>/ELV IPTV Player.app: mpv in MacOS/, its own dylibs in Frameworks/, licence texts and BUILDINFO.json in
# Resources/. Usage: build-macos.sh <work dir> <out dir>. Needs Xcode, meson, ninja, pkgconf and jq.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: build-macos.sh <work dir> <out dir>" >&2
  exit 2
fi
here="$(cd "$(dirname "$0")" && pwd)"
versions="$here/versions.json"
mkdir -p "$1" "$2"
work="$(cd "$1" && pwd)"
out="$(cd "$2" && pwd)"
prefix="$work/prefix"
jobs="$(sysctl -n hw.ncpu)"

MACOSX_DEPLOYMENT_TARGET="$(jq -er .macosDeploymentTarget "$versions")"
export MACOSX_DEPLOYMENT_TARGET
# Only our own prefix: a Homebrew library on the build machine must never be found or linked.
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
unset PKG_CONFIG_PATH

pin() { jq -er --arg n "$1" --arg k "$2" '.[$n][$k]' "$versions"; }

# Downloads a pinned tarball, refuses it unless its SHA-256 matches and unpacks it into $work/src/<name>.
unpack() {
  local name="$1" url sha file actual
  echo "==> $name $(pin "$name" version)"
  url="$(pin "$name" url)"
  sha="$(pin "$name" sha256)"
  file="$work/download/$name-$(basename "$url")"
  mkdir -p "$work/download" "$work/src/$name"
  curl -fsSL --retry 5 --retry-all-errors -o "$file" "$url"
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
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
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$(pin "$name" tag)" \
    --recurse-submodules "$(pin "$name" git)" "$work/src/$name"
  actual="$(git -C "$work/src/$name" rev-parse HEAD)"
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
    file="$work/src/$name/$path"
    if [ "$(shasum -a 256 "$file" | awk '{print $1}')" != "$before" ]; then
      echo "$name: $path is not the file the backport replaces" >&2
      exit 1
    fi
    curl -fsSL --retry 5 --retry-all-errors -o "$file" "$url"
    if [ "$(shasum -a 256 "$file" | awk '{print $1}')" != "$after" ]; then
      echo "$name: SHA-256 mismatch for $url" >&2
      exit 1
    fi
    echo "$name: backported $path from $url"
  done < <(jq -r --arg n "$name" '.[$n].backports // [] | .[] | [.path, .url, .sha256Before, .sha256] | @tsv' "$versions")
}

meson_build() {
  local name="$1"
  shift
  meson setup "$work/build/$name" "$work/src/$name" --prefix="$prefix" --libdir=lib \
    --buildtype=release --default-library=shared --wrap-mode=nofallback "$@"
  meson compile -C "$work/build/$name"
  meson install -C "$work/build/$name" --quiet
}

ffmpeg_flags=(
  --prefix="$prefix" --enable-shared --disable-static --disable-programs --disable-doc
  --enable-videotoolbox --enable-audiotoolbox --enable-securetransport
)
mpv_flags=(
  -Dgpl=false -Dcplayer=true -Dlibmpv=false -Dlua=luajit
  -Drubberband=disabled -Ddvdnav=disabled -Dcdda=disabled
)

unpack fribidi
meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
unpack freetype
meson_build freetype -Dharfbuzz=disabled -Dbrotli=disabled -Dbzip2=disabled -Dpng=disabled
unpack harfbuzz
meson_build harfbuzz -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled
unpack libass
meson_build libass -Dfontconfig=disabled -Dcoretext=enabled
clone libplacebo
meson_build libplacebo -Dvulkan=disabled -Dopengl=enabled -Dd3d11=disabled -Dglslang=disabled \
  -Dshaderc=disabled -Dlcms=disabled -Dlibdovi=disabled -Dxxhash=disabled -Ddemos=false
unpack luajit
make -C "$work/src/luajit" amalg PREFIX="$prefix" -j"$jobs"
make -C "$work/src/luajit" install PREFIX="$prefix"
unpack ffmpeg
mkdir -p "$work/build/ffmpeg"
(cd "$work/build/ffmpeg" && "$work/src/ffmpeg/configure" "${ffmpeg_flags[@]}")
make -C "$work/build/ffmpeg" -j"$jobs"
make -C "$work/build/ffmpeg" install
unpack mpv
backport mpv
meson_build mpv "${mpv_flags[@]}"

echo "==> bundle"
app="$out/ELV IPTV Player.app"
contents="$app/Contents"
fw="$contents/Frameworks"
res="$contents/Resources"
rm -rf "$app"
mkdir -p "$contents/MacOS" "$fw" "$res/licenses"
cp "$prefix/bin/mpv" "$contents/MacOS/mpv"
cp "$here/Info.plist" "$contents/Info.plist"
plutil -insert CFBundleShortVersionString -string "$(pin mpv version)" "$contents/Info.plist"
plutil -insert CFBundleVersion -string "$(pin mpv version)" "$contents/Info.plist"
plutil -insert LSMinimumSystemVersion -string "$MACOSX_DEPLOYMENT_TARGET" "$contents/Info.plist"
plutil -lint "$contents/Info.plist"

links() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }
rpaths() { otool -l "$1" | awk '$1 == "cmd" && $2 == "LC_RPATH" { getline; getline; print $2 }'; }

# The library in $prefix/lib that a load command names; nothing for a system library.
own_lib() {
  case "$1" in
    "$prefix"/lib/*) echo "$1" ;;
    @rpath/*) if [ -f "$prefix/lib/${1#@rpath/}" ]; then echo "$prefix/lib/${1#@rpath/}"; fi ;;
  esac
  return 0
}

# Copy every library mpv needs, transitively, as a real file named like its load command.
todo="$work/todo"
echo "$contents/MacOS/mpv" >"$todo"
while [ -s "$todo" ]; do
  file="$(head -n 1 "$todo")"
  tail -n +2 "$todo" >"$todo.next"
  mv "$todo.next" "$todo"
  while read -r dep; do
    lib="$(own_lib "$dep")"
    dest="$fw/$(basename "$dep")"
    if [ -n "$lib" ] && [ ! -e "$dest" ]; then
      cp -L "$lib" "$dest"
      chmod 755 "$dest"
      echo "$dest" >>"$todo"
    fi
  done < <(links "$file")
done

for file in "$contents/MacOS/mpv" "$fw"/*.dylib; do
  case "$file" in
    *.dylib) install_name_tool -id "@executable_path/../Frameworks/$(basename "$file")" "$file" ;;
  esac
  deps="$(links "$file")"
  while read -r dep; do
    if [ -n "$dep" ] && [ -n "$(own_lib "$dep")" ]; then
      install_name_tool -change "$dep" "@executable_path/../Frameworks/$(basename "$dep")" "$file"
    fi
  done <<<"$deps"
  paths="$(rpaths "$file")"
  while read -r rpath; do
    if [ -n "$rpath" ] && [ "$rpath" != /usr/lib/swift ]; then
      install_name_tool -delete_rpath "$rpath" "$file"
    fi
  done <<<"$paths"
done

# Nothing may load from the build machine (prefix, Xcode, Homebrew), and the archive must hold no symlinks.
fail=0
for file in "$contents/MacOS/mpv" "$fw"/*.dylib; do
  while read -r dep; do
    case "$dep" in
      /usr/lib/* | /System/Library/*) ;;
      @executable_path/../Frameworks/*)
        if [ ! -f "$fw/${dep##*/}" ]; then
          echo "$file: $dep is not in Frameworks" >&2
          fail=1
        fi
        ;;
      *)
        echo "$file: links $dep, outside the bundle and the system" >&2
        fail=1
        ;;
    esac
  done < <(links "$file")
  while read -r rpath; do
    if [ -n "$rpath" ] && [ "$rpath" != /usr/lib/swift ]; then
      echo "$file: keeps the rpath $rpath" >&2
      fail=1
    fi
  done < <(rpaths "$file")
done
if [ -n "$(find "$app" -type l)" ]; then
  echo "the bundle contains symlinks" >&2
  fail=1
fi
if [ "$fail" -ne 0 ]; then exit 1; fi

for name in fribidi freetype harfbuzz libass libplacebo luajit ffmpeg mpv; do
  mkdir -p "$res/licenses/$name"
  while read -r licence; do
    cp "$work/src/$name/$licence" "$res/licenses/$name/"
  done < <(jq -er --arg n "$name" '.[$n].licences[]' "$versions")
done
jq --arg ffmpeg "${ffmpeg_flags[*]:1}" --arg mpv "${mpv_flags[*]}" --arg xcode "$(xcodebuild -version | head -n 1)" \
  '{macosDeploymentTarget, xcode: $xcode, configure: {ffmpeg: $ffmpeg, mpv: $mpv}, sources: del(.macosDeploymentTarget)}' \
  "$versions" >"$res/BUILDINFO.json"

echo "==> sign"
for lib in "$fw"/*.dylib; do codesign --force -s - "$lib"; done
codesign --force -s - "$app"
codesign --verify --deep --strict "$app"

echo "==> smoke test"
mpv="$contents/MacOS/mpv"
"$mpv" --no-config --version
printf 'print("elv-lua-ok")\n' >"$work/lua-check.lua"
log="$("$mpv" --no-config --vo=null --ao=null --frames=1 --script="$work/lua-check.lua" \
  'av://lavfi:testsrc=size=64x64' 2>&1)" || {
  echo "$log" >&2
  exit 1
}
if ! grep -q elv-lua-ok <<<"$log"; then
  echo "$log" >&2
  echo "the Lua check script did not run" >&2
  exit 1
fi
"$mpv" --no-config --vo=help || true
"$mpv" --no-config --gpu-context=help || true
ls -l "$fw"

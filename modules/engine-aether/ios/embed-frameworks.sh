#!/bin/sh
# Embeds and signs the dynamic FFmpeg frameworks produced by the AetherEngine Swift package.
# React Native's `spm_dependency` links them into the static module pod, while embedding nothing.
set -eu

DEST="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"
mkdir -p "$DEST"
SIGN_ID="${EXPANDED_CODE_SIGN_IDENTITY:--}"
TARGET_ARCHS="${ARCHS:-}"

in_list() {
  needle="$1"
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

dsym_slice=""
case "${PLATFORM_NAME:-}" in
  appletvos) dsym_slice="tvos-arm64" ;;
  iphoneos) dsym_slice="ios-arm64" ;;
esac
spm_root="${BUILD_DIR%/Build/*}/SourcePackages/checkouts/FFmpegBuild/Sources"

seen=" "
for dir in "${BUILT_PRODUCTS_DIR}" "${BUILT_PRODUCTS_DIR}/PackageFrameworks"; do
  [ -d "$dir" ] || continue
  for fw in "$dir"/*.framework; do
    [ -d "$fw" ] || continue
    name=$(basename "$fw" .framework)
    case "$seen" in
      *" $name "*) continue ;;
    esac
    bin="$fw/$name"
    [ -f "$bin" ] || continue
    if ! file "$bin" | grep -q "dynamically linked shared library"; then
      echo "ELV embed: skip static $name"
      continue
    fi
    seen="$seen$name "
    dest_fw="$DEST/$name.framework"
    dest_bin="$dest_fw/$name"
    rm -rf "$dest_fw"
    rsync -a --delete --exclude Headers --exclude PrivateHeaders --exclude Modules "$fw" "$DEST/"
    chmod -R u+w "$dest_fw"

    thinned=0
    if [ -n "$TARGET_ARCHS" ]; then
      fw_archs=$(lipo -archs "$dest_bin")
      keep_archs=""
      keep_count=0
      need_thin=0
      for arch in $fw_archs; do
        # shellcheck disable=SC2086
        if in_list "$arch" $TARGET_ARCHS; then
          keep_archs="${keep_archs:+$keep_archs }$arch"
          keep_count=$((keep_count + 1))
        else
          need_thin=1
        fi
      done
      if [ "$need_thin" -eq 1 ] && [ "$keep_count" -gt 0 ]; then
        if [ "$keep_count" -eq 1 ]; then
          lipo "$dest_bin" -thin "$keep_archs" -output "$dest_bin.thin"
        else
          set --
          for arch in $keep_archs; do
            set -- "$@" -extract "$arch"
          done
          lipo "$dest_bin" "$@" -output "$dest_bin.thin"
        fi
        mv "$dest_bin.thin" "$dest_bin"
        thinned=1
        echo "ELV embed: thinned $name ($fw_archs -> $keep_archs)"
      fi
    fi

    if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ]; then
      codesign --force --sign "$SIGN_ID" --timestamp=none --preserve-metadata=identifier,entitlements "$dest_fw"
      echo "ELV embed: embedded and signed $name"
    else
      [ "$thinned" -eq 1 ] && rm -rf "$dest_fw/_CodeSignature"
      echo "ELV embed: embedded $name (unsigned)"
    fi

    if [ "${ACTION:-}" = "install" ] && [ -n "$dsym_slice" ] && [ -n "${DWARF_DSYM_FOLDER_PATH:-}" ]; then
      dsym="$spm_root/$name.xcframework/$dsym_slice/dSYMs/$name.framework.dSYM"
      if [ -d "$dsym" ]; then
        mkdir -p "$DWARF_DSYM_FOLDER_PATH"
        rm -rf "$DWARF_DSYM_FOLDER_PATH/$name.framework.dSYM"
        rsync -a --delete "$dsym" "$DWARF_DSYM_FOLDER_PATH/"
        chmod -R u+w "$DWARF_DSYM_FOLDER_PATH/$name.framework.dSYM"
        echo "ELV embed: copied dSYM $name.framework.dSYM"
      else
        echo "ELV embed: warning: missing dSYM $dsym"
      fi
    fi
  done
done

RES="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
mkdir -p "$RES"
for bundle in "${BUILT_PRODUCTS_DIR}"/*_*.bundle; do
  [ -d "$bundle" ] || continue
  name=$(basename "$bundle")
  if [ -d "$RES/$name" ]; then
    echo "ELV embed: bundle already present $name"
    continue
  fi
  rsync -a --delete "$bundle" "$RES/"
  chmod -R u+w "$RES/$name"
  echo "ELV embed: copied bundle $name"
done

#!/bin/sh
# Verifies the generated Apple Xcode project, simulator/device .app bundle, or .xcarchive for @elv/engine-aether.
# Usage: check-build.sh project <ios dir> | app <.app> | archive <.xcarchive>
set -eu

FRAMEWORKS="AetherLibavcodec AetherLibavfilter AetherLibavformat AetherLibavutil AetherLibdav1d AetherLibswresample AetherLibswscale AetherLibzimg AetherLibzvbi"
PHASE_NAME="[ELV] Embed AetherEngine frameworks"
failed=0

fail() {
  echo "FAIL: $1"
  failed=1
}

in_list() {
  needle="$1"
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

check_project() {
  ios_dir="$1"
  pbxproj=$(find "$ios_dir" -maxdepth 2 -path '*.xcodeproj/project.pbxproj' | head -n 1)
  if [ -z "$pbxproj" ] || [ ! -f "$pbxproj" ]; then
    fail "missing Xcode project under $ios_dir"
    return
  fi

  proj_json=$(plutil -convert json -o - "$pbxproj")

  phase_count=$(printf '%s' "$proj_json" | jq -r --arg name "$PHASE_NAME" '
    .objects as $o |
    [$o | to_entries[] | select(.value.isa == "PBXNativeTarget" and .value.productType == "com.apple.product-type.application") | .value][0] as $t |
    [$t.buildPhases[] | select($o[.].isa == "PBXShellScriptBuildPhase" and $o[.].name == $name)] | length
  ')
  [ "$phase_count" = "1" ] || fail "expected 1 '$PHASE_NAME' phase on app target, got $phase_count"

  last_name=$(printf '%s' "$proj_json" | jq -r '
    .objects as $o |
    [$o | to_entries[] | select(.value.isa == "PBXNativeTarget" and .value.productType == "com.apple.product-type.application") | .value][0] as $t |
    $o[($t.buildPhases | last)].name // ""
  ')
  [ "$last_name" = "$PHASE_NAME" ] || fail "expected '$PHASE_NAME' to be the last app build phase, got '$last_name'"

  script_rel=$(printf '%s' "$proj_json" | jq -r --arg name "$PHASE_NAME" '
    .objects as $o |
    [$o | to_entries[] | select(.value.isa == "PBXNativeTarget" and .value.productType == "com.apple.product-type.application") | .value][0] as $t |
    [$t.buildPhases[] | $o[.] | select(.isa == "PBXShellScriptBuildPhase" and .name == $name) | .shellScript][0] // ""
  ' | sed -n 's|^/bin/sh "\${SRCROOT}/\(.*\)"$|\1|p')
  if [ -z "$script_rel" ] || [ ! -f "$ios_dir/$script_rel" ]; then
    fail "embed script path missing or unresolved: $ios_dir/$script_rel"
  fi

  for cfg in Debug Release; do
    excl=$(printf '%s' "$proj_json" | jq -r --arg cfg "$cfg" '
      .objects as $o |
      [$o | to_entries[] | select(.value.isa == "PBXNativeTarget" and .value.productType == "com.apple.product-type.application") | .value][0] as $t |
      [$o[$t.buildConfigurationList].buildConfigurations[] | $o[.] | select(.name == $cfg) | .buildSettings["EXCLUDED_ARCHS[sdk=appletvsimulator*]"]][0] // ""
    ')
    [ "$excl" = "x86_64" ] || fail "app target $cfg missing EXCLUDED_ARCHS[sdk=appletvsimulator*]=x86_64 (got '$excl')"
  done

  pods_pbxproj="$ios_dir/Pods/Pods.xcodeproj/project.pbxproj"
  if [ ! -f "$pods_pbxproj" ]; then
    fail "missing $pods_pbxproj"
    return
  fi
  spm_ok=$(plutil -convert json -o - "$pods_pbxproj" | jq -r '
    [.objects | to_entries[] | .value
      | select(.isa == "XCRemoteSwiftPackageReference")
      | select((.repositoryURL // "") | test("AetherEngine"))
      | select(.requirement.kind == "exactVersion" and .requirement.version == "7.66.1")
    ] | length
  ')
  [ "$spm_ok" = "1" ] || fail "Pods.xcodeproj lacks XCRemoteSwiftPackageReference for AetherEngine exactVersion 7.66.1 (got $spm_ok)"
}

check_app() {
  app="$1"
  if [ -z "$app" ] || [ ! -d "$app" ]; then
    fail "missing .app directory: $app"
    return
  fi

  info_plist="$app/Info.plist"
  if [ ! -f "$info_plist" ]; then
    fail "missing $info_plist"
    return
  fi

  exec_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist" 2>/dev/null || true)
  main_bin="$app/$exec_name"
  if [ -z "$exec_name" ] || [ ! -f "$main_bin" ]; then
    fail "missing main executable $main_bin"
    return
  fi
  main_archs=$(lipo -archs "$main_bin")

  for fw in $FRAMEWORKS; do
    fw_dir="$app/Frameworks/$fw.framework"
    fw_bin="$fw_dir/$fw"
    if [ ! -f "$fw_bin" ]; then
      fail "missing embedded framework binary $fw_bin"
      continue
    fi
    for forbidden in Headers PrivateHeaders Modules; do
      [ ! -e "$fw_dir/$forbidden" ] || fail "$fw.framework still contains $forbidden"
    done
    fw_archs=$(lipo -archs "$fw_bin")
    for arch in $fw_archs; do
      # shellcheck disable=SC2086
      in_list "$arch" $main_archs || fail "$fw.framework arch '$arch' is outside main executable archs ($main_archs)"
    done
  done

  [ -d "$app/AetherEngine_AetherEngine.bundle" ] || fail "missing $app/AetherEngine_AetherEngine.bundle"

  if ! otool -L "$main_bin" | grep -q '@rpath/AetherLibavcodec\.framework/'; then
    fail "main executable does not link @rpath/AetherLibavcodec.framework"
  fi

  if codesign -dv "$main_bin" >/dev/null 2>&1; then
    codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail "codesign --verify --deep --strict failed on $app"
  fi
}

check_archive() {
  archive="$1"
  if [ -z "$archive" ] || [ ! -d "$archive" ]; then
    fail "missing .xcarchive directory: $archive"
    return
  fi

  app=$(find "$archive/Products/Applications" -maxdepth 1 -name '*.app' | head -n 1)
  check_app "$app"
  [ -n "$app" ] && [ -d "$app" ] || return

  exec_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist" 2>/dev/null || true)
  main_archs=$(lipo -archs "$app/$exec_name")
  [ "$main_archs" = "arm64" ] || fail "archived executable archs must be 'arm64', got '$main_archs'"

  for fw in $FRAMEWORKS; do
    fw_dir="$app/Frameworks/$fw.framework"
    fw_bin="$fw_dir/$fw"
    if [ -f "$fw_bin" ]; then
      fw_archs=$(lipo -archs "$fw_bin")
      [ "$fw_archs" = "arm64" ] || fail "archived $fw.framework archs must be 'arm64', got '$fw_archs'"
    fi
    fw_plist="$fw_dir/Info.plist"
    if [ ! -f "$fw_plist" ]; then
      fail "missing $fw_plist"
    else
      pkg_type=$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' "$fw_plist" 2>/dev/null || true)
      min_os=$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$fw_plist" 2>/dev/null || true)
      [ "$pkg_type" = "FMWK" ] || fail "$fw.framework CFBundlePackageType='$pkg_type' (expected FMWK)"
      [ -n "$min_os" ] || fail "$fw.framework Info.plist lacks MinimumOSVersion"
    fi
    [ -d "$archive/dSYMs/$fw.framework.dSYM" ] || fail "missing dSYM $archive/dSYMs/$fw.framework.dSYM"
  done
}

mode="${1:-}"
target="${2:-}"
case "$mode" in
  project) check_project "$target" ;;
  app) check_app "$target" ;;
  archive) check_archive "$target" ;;
  *)
    echo "usage: $0 project <ios dir> | app <.app> | archive <.xcarchive>" >&2
    exit 2
    ;;
esac

exit "$failed"

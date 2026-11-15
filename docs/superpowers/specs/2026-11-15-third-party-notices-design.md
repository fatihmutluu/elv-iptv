# In-App Third-Party Software Notices & LGPL Provenance Verification — Design

- Status: approved (owner delegated all development decisions until `0.1` ships)
- Date: 2026-11-15
- Issue: #98 (Show third-party software notices in the apps)
- Builds on: Foundation Spec (`2026-11-13-foundation-design.md` §3, §5.2), Community & Licensing Spec, Plain Menu Spec (`2026-11-15-plain-menu-design.md`).

## 1. Why

Shipped ELV IPTV `0.1` binaries across `tv-mobile` (Android, Fire OS, tvOS, iOS, iPadOS) and `desktop` (Windows, macOS, Linux) dynamically link LGPL native media libraries (`AetherEngine 7.66.1` + 9 `AetherLib*.framework` FFmpeg/codec libraries on Apple; `Media3` + LGPL FFmpeg `9.0.2` audio extension on Android; out-of-process LGPL `libmpv 0.42.0` + FFmpeg on Desktop) alongside permissive native bindings (`op-sqlite`, `better-sqlite3`, `Electron`) and bundled JS runtime dependencies.

To satisfy LGPL attribution/source-link obligations and permissive open-source notices offline on every screen (including TV devices with no browser), both apps must expose an offline, scrollable **Third-party notices** view backed by an automated check that fails `pnpm check` whenever runtime dependencies or native lock pins drift from the committed notices data.

## 2. Architecture & Data Flow

1. **Generator & Verifier (`tools/src/notices/` + `pnpm check --only notices`):**
   - Inspects runtime `dependencies` across shipped app and workspace `package.json` manifests (`apps/tv-mobile`, `apps/desktop`, `apps/desktop/renderer`, `packages/*`, `modules/*`), resolving exact installed versions, `license`, homepage/repository URL, and `LICENSE*`/`NOTICE*` summaries from `node_modules`.
   - Reads exact native engine lock pins directly from repository lock/spec files:
     - `modules/engine-aether/ios/ElvEngineAether.podspec`: `AetherEngine` exact version (`7.66.1`), upstream repository URL (`https://github.com/superuser404notfound/AetherEngine`), LGPL-3.0 + App Store/DRM exception summary, explicit unmodified-binary statement, and the 9 dynamic `AetherLib*.framework` FFmpeg/codec libraries + `libdovi` / `dav1d` / `zimg` / `zvbi` notices.
     - `modules/engine-media3/ffmpeg-media3.lock.json`: AndroidX `Media3` (`1.11.1`, `Apache-2.0`) and the dynamic LGPL-2.1+ FFmpeg (`9.0.2`) audio decoder extension (`ffmpeg-media3.yml` build workflow & source provenance).
     - `apps/desktop/mpv-runtime.lock.json`: Desktop LGPL-2.1+ `libmpv` (`0.42.0`) + FFmpeg runtime (`win32-x64` upstream release URL and `darwin-arm64` `mpv-runtime.yml` build provenance).
   - Emits deterministic TypeScript data into `packages/features/src/notices/notices-data.ts` (zero runtime fs/network access; pure static array of `{ id, name, version, license, platforms, sourceUrl, modificationNote?, noticeText }`) via `pnpm notices:sync` (`node tools/bin/notices.ts --write`), while `checkNotices()` in `tools/src/checks.ts` (`pnpm check --only notices`) verifies byte-for-byte freshness on every PR and pre-push check.
2. **Cross-Platform UI (`packages/features/src/notices/ThirdPartyNoticesScreen.tsx` + `AppShell.tsx`):**
   - Plain, zero-network screen reachable from top-level navigation (`'notices'` tab in `AppShell`, localized EN `"Notices"` / `"Third-party software notices"` and TR `"Lisanslar"` / `"Üçüncü taraf yazılım bildirimleri"`).
   - Renders an introductory LGPL dynamic-linking & source-offer header followed by deterministic component cards/entries.
   - Uses `ElvList` / D-pad step scrolling on `'tv'` (`Up`/`Down` scrolls smoothly by item/step with `Back` returning to the top tab bar, isolating native Android `ScrollView` focus) and standard scrollable list/text on `'phone'`, `'tablet'`, and `'desktop'`.

## 3. Testing Strategy

- **`@elv/tools` (`tools/test/notices.test.ts`):** Unit + workspace tests proving `buildNoticesData` extracts exact versions from `ffmpeg-media3.lock.json`, `mpv-runtime.lock.json`, `ElvEngineAether.podspec`, and workspace `package.json`s, and fails `verifyNoticesData` immediately when a dependency or native lock version changes without regenerating `notices-data.ts`.
- **`@elv/i18n`:** EN/TR message parity for notices tab and headings.
- **`@elv/features` (`ThirdPartyNoticesScreen.test.tsx`):** Verifies offline rendering of `AetherEngine 7.66.1`, `FFmpeg 9.0.2`, `libmpv 0.42.0`, `Media3 1.11.1`, `op-sqlite`, `better-sqlite3`, and JS dependencies, plus TV D-pad `Up`/`Down`/`Back` navigation and `AppShell` tab reachability across `'tv'`, `'phone'`, and `'desktop'`.

# Wave F8 Design Spec — Proprietary License Transition, Official Store Compliance & Desktop MSIX/MAS Packaging (#486, #77)

- **Date:** 2026-11-25
- **Issues:** Closes #486, Closes #77
- **Product Decision:** #41 (Proprietary closed-source app distributed exclusively through official app stores; GitHub repository remains public for CI capacity; zero third-party GPL media libraries; LGPL/MIT/Apache dynamic-linking notices preserved).

## 1. Goals & Scope
1. **Proprietary License Transition (`#486`, ADR `0016` superseding `0012`):**
   - Replace `LICENSE` with a Proprietary / All Rights Reserved copyright notice stating that third-party open-source dependencies retain their upstream licenses (listed in-app under Third-Party Notices).
   - Update the root manifest and all 20 workspace `package.json` manifests to `"license": "UNLICENSED"`, update all 4 CocoaPods `.podspec` files to `Proprietary`, update `tools/src/scaffold.ts` and license-check tests, and keep `.github/workflows/cla.yml` reporting job `cla` green for required branch protection.
   - Update public repo docs (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/INDEX.md`, `docs/adr/0012-gpl-3-and-cla.md`, `docs/adr/0016-proprietary-store-only-distribution.md`, `docs/adr/README.md`) and EN/TR app copy (`packages/i18n`) from open-source / `GPL-3.0-only` wording to Proprietary (`Proprietary · LGPL media engines` / `Tescilli · LGPL medya motorları`) while keeping `ThirdPartyNotices` intact and green (`pnpm check --only notices`).
2. **Apple, Google Play, Amazon & Microsoft Store Compliance (`#486`):**
   - Configure `ios.privacyManifests` in `apps/tv-mobile/config/build-app-config.ts` so Expo prebuild generates `PrivacyInfo.xcprivacy` for iOS, iPadOS, and tvOS declaring `NSPrivacyTracking: false`, `NSPrivacyCollectedDataTypes: []`, and all 4 Required Reason APIs actually exercised by the app and native pods (`UserDefaults: CA92.1`, `FileTimestamp: C617.1`, `SystemBootTime: 35F9.1`, `DiskSpace: E174.1`).
   - Update `NSLocalNetworkUsageDescription` to reflect both AirPlay receiver discovery and local-network QR pairing.
   - Extend `tools/src/release-hygiene.ts` + `tools/bin/release-hygiene.ts` with `checkApplePrivacyManifest()` (`--apple-privacy-manifest`) validating `NSPrivacyTracking = false` and all 4 required API reason codes.
   - Author `docs/release/STORE_COMPLIANCE.md` covering Apple App Store (incl. Guideline 5.1.1(v) in-app Delete Account, Guideline 4.8 Sign in with Apple seam, ATS justification, App Privacy worksheet), Mac App Store App Sandbox, Microsoft Store MSIX & IARC age rating, Google Play Data Safety + hosted `/account-deletion` page + Android TV Leanback checklist, Amazon Appstore Fire OS zero-GMS compliance, and Privacy Policy / Terms templates.
3. **Official Store-Only Desktop Packaging — MSIX & Mac App Store Sandbox (`#77`):**
   - Retire standalone `.exe` (`nsis`) and `.dmg` installers from `apps/desktop/electron-builder.yml` (default `win.target: [dir]` and `mac.target: [dir]` so unpacked CI/E2E verification and `packaged.spec.ts` stay green without producing standalone installers).
   - Add Microsoft Store MSIX (`appx`) packaging configuration (`apps/desktop/package.json` `"package:msix"`, minimal capabilities, language list, tile PNG assets in `apps/desktop/resources/appx/`).
   - Add Mac App Store (`mas`) packaging configuration (`apps/desktop/package.json` `"package:mas"`, `mac.extendInfo` ATS/encryption/local-network plist keys, expanded `apps/desktop/resources/entitlements.mas.plist` with `network.server`, `files.user-selected.read-write`, and `application-groups`, keeping `electronFuses` 100% intact).
   - Harden macOS App Sandbox runtime paths in `apps/desktop`:
     - `iosurface.ts`: `createCanvasEndpoint('darwin')` MUST NEVER fall back to `/tmp` (denied in MAS sandbox) when `isMas` is true.
     - `factory.ts`: When `platform === 'darwin'` and `isMas` is true, select `'own-window'` presenter cleanly instead of cross-process `IOSurfaceLookup` (blocked by MAS sandbox).
   - Update `.github/workflows/native.yml` so desktop CI no longer expects `*.exe` or `*.dmg` artifacts, and Apple iOS/tvOS release-hygiene verifies the generated `PrivacyInfo.xcprivacy`.

## 2. Invariants
- Zero third-party GPL binaries or libraries; `pnpm check --only notices` stays 100% green.
- Zero mentions of `"DVR"` / `"recording"` or third-party competitor brand names anywhere in public copy, tests, or docs.
- All 6 `electronFuses` in `apps/desktop/electron-builder.yml` remain unchanged (`static-invariants.ts`).
- `cla` check in `.github/workflows/cla.yml` stays green (required by branch protection).
- Every file `<= 800` lines; pure package coverage `>= 90%`; `pnpm check` `0 failed`.

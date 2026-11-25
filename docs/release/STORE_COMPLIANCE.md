# Official Store Compliance & Submission Workbook

This workbook is the release-time compliance reference for submitting **ELV IPTV** (`io.github.fatihmutluu.elviptv`) across all five official storefronts:

1. **Apple App Store** (iOS, iPadOS, tvOS)
2. **Mac App Store** (macOS App Sandbox)
3. **Microsoft Store** (Windows MSIX)
4. **Google Play** (Android & Android TV)
5. **Amazon Appstore** (Fire TV)

> **Distribution model:** ELV IPTV is a proprietary closed-source media player distributed exclusively through official app stores. It ships **zero media content**, **zero playlists**, and **zero content subscriptions**. Users supply their own M3U/M3U8 playlists or Xtream Codes server credentials. Third-party open-source dependencies (including dynamically linked LGPL media engines) retain their upstream licenses and are disclosed in-app under **Settings → About → Third-Party Notices**.

---

## 1. Apple App Store (iOS, iPadOS, tvOS)

### 1.1 Privacy Manifest (`PrivacyInfo.xcprivacy`)

Configured in `apps/tv-mobile/config/build-app-config.ts` (`ios.privacyManifests`), emitted by `expo prebuild`, and verified in CI by `node tools/bin/release-hygiene.ts --apple-privacy-manifest <path>`:

- `NSPrivacyTracking`: `false`
- `NSPrivacyTrackingDomains`: `[]`
- `NSPrivacyCollectedDataTypes`: `[]` (local-only mode; updated in App Store Connect when optional Wave F9 sync/diagnostics are enabled)
- `NSPrivacyAccessedAPITypes` (all 4 Required Reason APIs exercised by ELV IPTV and its native pods):

| API Category | Reason Code | Usage Justification |
|---|---|---|
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | Read/write app preferences and native module state strictly within ELV IPTV's own app container (`UserDefaults`). |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1` | File modification timestamps inside the app container used by Expo/React Native cache housekeeping, EPG cache freshness, and artwork storage. |
| `NSPrivacyAccessedAPICategorySystemBootTime` | `35F9.1` | Monotonic uptime (`ProcessInfo.systemUptime`) for playback buffering/stall timing, channel-switch latency measurement, and UI animation clocks. |
| `NSPrivacyAccessedAPICategoryDiskSpace` | `E174.1` | `op-sqlite` / SQLite `statfs` and `fstatvfs` available-space checks before catalog database writes and cache eviction. |

### 1.2 App Privacy Worksheet (App Store Connect)

| Mode | Data Collection Answer | Details |
|---|---|---|
| **Local-only (default)** | **Data Not Collected** | All playlists, credentials (stored in Apple Keychain), watch history, favorites, and EPG caches remain strictly on-device. |
| **Optional E2EE Sync Account (Wave F9)** | **Contact Info (Email Address)** — *App Functionality*, linked to user, not used for tracking | Used solely to authenticate the optional End-to-End Encrypted (E2EE) sync account. Synced payloads (playlists, favorites, watch progress) are encrypted client-side before upload; the server stores opaque ciphertext only. |
| **Opt-in Diagnostics (Wave F9)** | **Diagnostics (Crash Data / Performance Data)** — *App Functionality*, not linked to user, not used for tracking | Disabled by default. Only sent if the user explicitly opts in under Settings. Never includes playlist URLs, stream URLs, or provider credentials. |

### 1.3 Key App Review Guidelines

- **Guideline 5.1.1(v) — Account Deletion:** Whenever account creation is available (Wave F9 E2EE Sync), an in-app **Delete Account** action is provided directly in **Settings → Sync Account**, reachable via both touch (iOS/iPadOS) and 100% D-pad / Siri Remote focus navigation (tvOS). Confirming deletion permanently erases the server-side sync account and clears local sync tokens.
- **Guideline 4.8 — Sign in with Apple:** Phase 1 sync uses first-party email + password authentication only, which is exempt from Guideline 4.8. The auth architecture includes a provider seam so **Sign in with Apple** is enabled before any third-party social login provider is ever added.
- **Guideline 2.5.4 — Background Audio:** `UIBackgroundModes: ['audio']` is declared on iOS/iPadOS builds only (omitted on tvOS) to allow uninterrupted audio playback when the device is locked or another app is foregrounded.
- **App Transport Security (`NSAppTransportSecurity`):** `NSAllowsArbitraryLoads: true` is declared because users supply third-party M3U/Xtream Codes endpoints that frequently serve plain HTTP streams. `NSAllowsLocalNetworking` is intentionally omitted (Apple ignores `NSAllowsArbitraryLoads` when both keys are present).
- **Local Network & Bonjour (`NSLocalNetworkUsageDescription`, `NSBonjourServices`):**
  - `NSBonjourServices: ['_airplay._tcp']`
  - `NSLocalNetworkUsageDescription`: *"ELV IPTV uses your local network to discover AirPlay receivers and pair devices over QR code."*
- **Export Compliance:** `ITSAppUsesNonExemptEncryption: false` (uses only standard OS TLS/HTTPS and exempt encryption).
- **LGPL Dynamic Linking:** Proprietary app bundle dynamically links LGPL media engine frameworks and displays full third-party license notices in-app under **Settings → About → Third-Party Notices**.

### 1.4 App Review Notes (Apple)

> ELV IPTV is a neutral bring-your-own-playlist media player. It does not include, host, sell, or promote any TV channels, movies, or media streams.
> To test playback without a private provider, add a sample public-domain HLS stream (e.g., an `.m3u8` test URL) via **Sources → Add M3U Playlist** or scan a local-network QR pairing code.
> `NSAllowsArbitraryLoads` is required because user-configured IPTV providers and local-network media servers commonly use plain HTTP endpoints.
> Background audio (`UIBackgroundModes: audio`) on iOS/iPadOS supports listening to live radio/audio streams while the screen is locked.

---

## 2. Mac App Store (macOS App Sandbox)

### 2.1 Entitlements Breakdown

Main app bundle (`apps/desktop/resources/entitlements.mas.plist`):

| Entitlement | Value | Purpose |
|---|---|---|
| `com.apple.security.app-sandbox` | `true` | Required by the Mac App Store. |
| `com.apple.security.application-groups` | `$(TeamIdentifierPrefix)io.github.fatihmutluu.elviptv` | Shared sandbox container for main and helper processes. |
| `com.apple.security.files.user-selected.read-write` | `true` | Allows users to open/save `.m3u`, `.m3u8`, and backup files via native macOS Open/Save dialogs. |
| `com.apple.security.network.client` | `true` | Outbound HTTP/HTTPS connections to user-supplied IPTV servers and optional E2EE sync. |
| `com.apple.security.network.server` | `true` | Local-network listener for QR code device pairing. |

Helper processes (`apps/desktop/resources/entitlements.mas.inherit.plist`):
- `com.apple.security.app-sandbox`: `true`
- `com.apple.security.inherit`: `true`

### 2.2 Sandbox Runtime Guarantees

- When running under the Mac App Store sandbox (`process.mas === true`), the video presenter selects the sandbox-safe `'own-window'` path instead of cross-process `IOSurfaceLookup`.
- Temporary IPC sockets/endpoints never fall back to `/tmp` (denied inside the macOS App Sandbox).
- All 6 Electron Fuses remain enabled in `apps/desktop/electron-builder.yml`.

### 2.3 Mac App Store Signing & CI Secret Checklist (`package:mas`)

Build command: `pnpm --filter @elv/desktop package:mas`

Required CI / release secrets:
- [ ] `CSC_LINK` & `CSC_KEY_PASSWORD` — *3rd Party Mac Developer Application* certificate (`.p12`, base64-encoded).
- [ ] `CSC_INSTALLER_LINK` & `CSC_INSTALLER_KEY_PASSWORD` — *3rd Party Mac Developer Installer* certificate (`.p12`, for `.pkg` signing).
- [ ] `APPLE_PROVISIONING_PROFILE` — Mac App Store distribution `.provisionprofile` matching `io.github.fatihmutluu.elviptv` and the configured Application Group.
- [ ] `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — App Store Connect API key for automated upload via `xcrun altool` / Transporter.
- [ ] `mac.extendInfo` includes `ITSAppUsesNonExemptEncryption: false`, `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }`, and `NSLocalNetworkUsageDescription`.

---

## 3. Microsoft Store (Windows MSIX)

### 3.1 MSIX (`appx`) Manifest & Capabilities

Build command: `pnpm --filter @elv/desktop package:msix`

Minimal declared capabilities:
- `runFullTrust` — Required for Electron desktop applications packaged as MSIX.
- `internetClient` — Outbound connections to user-supplied IPTV providers and optional E2EE sync.
- `privateNetworkClientServer` — Local-network QR code pairing and LAN media server playback.

### 3.2 Partner Center Identity & Substitution Checklist

Before uploading the `.msix` / `.appx` package to Microsoft Partner Center, verify that `electron-builder.yml` `appx` metadata matches the reserved Partner Center app identity:
- [ ] `identityName` matches **Package/Identity/Name** in Partner Center.
- [ ] `publisher` matches **Package/Identity/Publisher** (`CN=...` GUID assigned by Partner Center).
- [ ] `publisherDisplayName` matches the verified Partner Center publisher name.
- [ ] `applicationId` is stable across upgrades.
- [ ] Required tile PNG assets exist in `apps/desktop/resources/appx/` (`Square44x44Logo`, `Square150x150Logo`, `Wide310x150Logo`, `StoreLogo`).
- [ ] File associations registered for `.m3u` and `.m3u8` playlists.

### 3.3 Signing & Smart App Control

- Microsoft Store re-signs uploaded MSIX packages with Microsoft's Store certificate during ingestion.
- Because the app is distributed exclusively via Microsoft Store, users receive full **Smart App Control** and **Windows Defender SmartScreen** trust without requiring a standalone EV code-signing certificate.

### 3.4 IARC Age Rating Worksheet

- **App Category:** Utility / Media Player (Bring-Your-Own-Content)
- **Bundled Content:** None (no channels, videos, or audio shipped).
- **Violence / Sexual Content / Profanity / Substances:** None.
- **User-Generated Content / Online Interaction:** No user-to-user chat, social feeds, or content sharing.
- **Unrestricted Internet Access:** User may enter custom playlist URLs (disclosed truthfully in the IARC questionnaire).
- **In-App Purchases / Ads:** Disclose accurately per release (no third-party ad SDKs).

---

## 4. Google Play (Android & Android TV)

### 4.1 Data Safety Worksheet

| Mode | Collected Data | Shared with Third Parties | Encrypted in Transit | Deletion Mechanism |
|---|---|---|---|---|
| **Local-only (default)** | None | No | N/A (on-device only) | Uninstall or clear app data |
| **Optional E2EE Sync (Wave F9)** | Email address (Account Management / App Functionality); encrypted sync blob (opaque ciphertext) | No | Yes (HTTPS/TLS + client-side E2EE) | In-app **Delete Account** + hosted web `GET /account-deletion` (`#26`) |
| **Opt-in Diagnostics (Wave F9)** | Crash logs & anonymized playback metrics (only if user opts in) | No | Yes (HTTPS/TLS) | Opt-out toggle in Settings |

### 4.2 Account Deletion Requirement (`#26`)

Google Play requires both an in-app deletion path and a public web deletion URL for any app that supports account creation:
- **In-app:** **Settings → Sync Account → Delete Account** (100% reachable on touch and Android TV D-pad).
- **Public web URL:** Hosted `GET /account-deletion` page on the sync server domain explaining what data is permanently deleted, retention period (immediate deletion), and providing a self-service deletion request flow.

### 4.3 Android TV Leanback Checklist

- [ ] `android.software.leanback` declared (`EXPO_TV=1`), verified by `release-hygiene.ts --tv`.
- [ ] `LEANBACK_LAUNCHER` intent filter present on main activity.
- [ ] `android.hardware.touchscreen` declared with `android:required="false"`.
- [ ] 320×180 px Android TV banner (`./assets/tv-banner.png`) configured via `@react-native-tvos/config-tv`.
- [ ] 100% D-pad navigation coverage across onboarding, source setup, live/VOD catalogs, player controls, and settings (zero mouse-only or touch-only traps).
- [ ] Legacy storage permissions (`READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`) explicitly blocked in `build-app-config.ts` and verified absent by `release-hygiene.ts`.
- [ ] `android:usesCleartextTraffic="true"` enabled for user-supplied HTTP playlists and verified by `release-hygiene.ts`.

### 4.4 Google Play Review Notes

> ELV IPTV is a media player utility for user-supplied M3U/M3U8 playlists and Xtream Codes servers. No media content, channels, or subscriptions are included or sold in the app. Reviewers can test playback by adding any public-domain HLS (`.m3u8`) playlist URL under **Sources → Add M3U Playlist**.

---

## 5. Amazon Appstore (Fire TV)

### 5.1 Zero-GMS / Zero-Firebase Verification

- Amazon Fire OS builds are built with `STORE=amazon EXPO_TV=1`.
- CI runs `node tools/bin/release-hygiene.ts --gradle-deps <deps.txt> --android-manifest <AndroidManifest.xml> --tv`, which fails the build if any `com.google.android.gms` or `com.google.firebase` artifact or manifest component appears in `releaseRuntimeClasspath` or the merged manifest.

### 5.2 Fire OS Requirements

- **Minimum SDK:** API 28 (`minSdkVersion: 28`, Fire OS 7 / Fire OS 8+).
- **Voice Permission:** `com.amazon.permission.media.session.voicecommandcontrol` is declared exclusively on TV and `STORE=amazon` builds (`build-app-config.ts`).
- **Remote Navigation:** Full Fire TV remote support (D-pad, Select, Back, Menu, Play/Pause, Rewind, Fast-Forward).
- **Review Notes:** Same neutral utility statement as Google Play (zero bundled media; user-supplied playlists only).

---

## 6. Privacy Policy & Terms of Service Templates

Host these documents on the sync server domain (e.g., `/privacy`, `/terms`, and `/account-deletion`) and link them in every storefront listing and in-app under **Settings → About**.

### 6.1 Privacy Policy Template

```markdown
# ELV IPTV Privacy Policy

**Effective Date:** YYYY-MM-DD  
**Controller / Contact:** <Publisher Name> (<support@example.com>)

## 1. Summary
ELV IPTV is a media player for playlists and servers that you provide. By default, ELV IPTV operates entirely on your device and does not collect, sell, or share personal data.

## 2. Local-Only Mode (Default)
When you use ELV IPTV without signing in to an optional sync account:
- Your M3U/Xtream credentials are stored locally in your operating system's secure credential store (Keychain / Keystore / Credential Manager).
- Your catalog cache, favorites, and playback progress are stored locally on your device.
- ELV IPTV connects directly to the playlist and stream servers you configure. Those third-party servers are governed by their own privacy policies.

## 3. Optional End-to-End Encrypted Sync Account
If you choose to create an optional ELV IPTV sync account:
- **Account Data:** We store your email address and authentication credentials solely to provide account sign-in and cross-device sync.
- **Encrypted Sync Data:** Your playlists, favorites, and playback state are encrypted on your device before upload. We cannot read your synced playlists or viewing history.
- **No Tracking or Ads:** We do not use advertising SDKs, cross-app tracking, or data brokers.

## 4. Optional Diagnostics
Crash reports and anonymized playback performance metrics are **disabled by default**. If you explicitly enable diagnostics in Settings, reports exclude playlist URLs, stream URLs, and server credentials.

## 5. Account & Data Deletion
You can permanently delete your sync account and all associated server data at any time:
- **In-App:** Open **Settings → Sync Account → Delete Account**.
- **On the Web:** Visit `<https://your-sync-domain.example/account-deletion>`.
Local data can be cleared at any time in Settings or by uninstalling the app.

## 6. Children's Privacy
ELV IPTV does not knowingly collect personal information from children under 13 (or the applicable age of digital consent in your jurisdiction).

## 7. Contact
For privacy inquiries or data deletion assistance, email `<support@example.com>`.
```

### 6.2 Terms of Service Template

```markdown
# ELV IPTV Terms of Service

**Effective Date:** YYYY-MM-DD  
**Publisher:** <Publisher Name> (<support@example.com>)

## 1. Media Player Only — No Content Provided
ELV IPTV is a proprietary software media player. ELV IPTV does not provide, host, stream, endorse, or sell any television channels, movies, series, playlists, or media content.

## 2. User Responsibility
You are solely responsible for the playlists, server credentials, and media streams you configure in ELV IPTV, and for ensuring you have the legal right to access and view that content in your jurisdiction.

## 3. License & Third-Party Software
ELV IPTV is licensed, not sold, under a proprietary end-user license subject to the terms of the official app store from which you downloaded it. Third-party open-source components retain their respective licenses as listed in-app under **Settings → About → Third-Party Notices**.

## 4. Optional Sync Service
If you create an optional sync account, you are responsible for safeguarding your account credentials and encryption passphrase. We may suspend accounts that abuse service infrastructure. You may delete your account at any time in-app or via `<https://your-sync-domain.example/account-deletion>`.

## 5. Disclaimer & Limitation of Liability
ELV IPTV is provided "as is" without warranties of any kind to the maximum extent permitted by applicable law. We are not responsible for the availability, accuracy, or legality of third-party streams or servers.

## 6. Contact
Questions about these Terms may be sent to `<support@example.com>`.
```

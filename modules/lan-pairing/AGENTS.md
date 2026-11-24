# lan-pairing (`@elv/lan-pairing`)

Android and Apple (iOS/tvOS) Expo native module hosting an ephemeral local-network HTTP server for phone-to-TV QR source pairing (`#50`).
Spec: `docs/superpowers/specs/2026-11-24-wave-f2-living-room-ergonomics-design.md` (§2.2, §2.3).

## API (`src/index.ts`)
- `isLanPairingNativeAvailable(): boolean` — `false` on web or when the native module is absent.
- `generateLanPairingToken(): string | null` — generates a 192-bit (48-hex-char) CSPRNG token via native `SecureRandom` / `SecRandomCopyBytes` (`null` when unavailable).
- `startLanPairingServer({ token, html, ttlMs, maxBodyBytes?, maxFailedAttempts? })` — starts a single-use listener on an ephemeral port and returns `{ host, port, url, expiresAtMs }`.
- `stopLanPairingServer()` — stops any active listener (safe no-op when unavailable or already stopped).
- `addLanPairingSubmissionListener(listener)` — subscribes to native `onSubmission` (`{ body, contentType? }`); returns a no-op `{ remove() {} }` when unavailable.

## Native Security & Lifecycle
- **Android (`android/`, `ElvLanPairingModule.kt`, `LanPairingHttpServer.kt`, `LanPairingPayloadValidator.kt`):** `java.net.ServerSocket(0)` dispatching to a bounded 4-worker daemon pool with a hard 5s wall-clock request deadline; discovers non-loopback RFC1918 IPv4 via `NetworkInterface` (preferring `wlan`/`eth`).
- **Apple (`ios/`, `ElvLanPairingModule.swift`, `LanPairingServer.swift`, `LanPairingValidation.swift`):** `Network.framework` `NWListener` (iOS 18+ / tvOS 18+) with `getifaddrs` non-loopback RFC1918 IPv4 lookup (`en0`/`en1`).
- Both hosts enforce private-LAN/loopback peer validation, exact `Host` and same-origin `Origin` checks, constant-time `/pair/<token>` verification, 16 KiB body cap, `Content-Type` + M3U/Xtream POST payload validation (`400` without consuming the session on invalid payloads), 5-attempt lockout, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.
- Never log request bodies, headers, URLs, or credentials. Listener closes immediately on first valid POST submission, TTL expiry, `stopServer`, or module `OnDestroy`/`deinit`.

## Rules & Tests
- Imports `expo-modules-core` only; platforms `android` & `apple` (`:elv-lan-pairing` / `ElvLanPairing`).
- TS: `pnpm --filter @elv/lan-pairing test` & `pnpm --filter @elv/lan-pairing typecheck`.
- Android JVM unit tests: `LanPairingHttpServerTest.kt` (`./gradlew :elv-lan-pairing:testDebugUnitTest`).

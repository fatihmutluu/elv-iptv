# Wave 7 — Security Architecture, Threat Model & Automated Pre-Release Security Gate (`#100`)

**Date:** 2026-11-22
**Branch:** `feat/security-gate`
**Closes:** `#100`

## 1. Goal

Establish ELV IPTV's end-to-end security posture as a two-layer system:
1. **Write-time architecture, invariants, and guardrails:** Explicit threat model, trust boundaries, shared credential redaction in `@elv/domain`, cross-layer prototype-pollution and scheme-allowlist enforcement, parser DoS bounds, local storage file permissions, and agent/linter guardrails.
2. **Verify-time automated gate & CI (`pnpm gate security`):** A single repeatable pre-release and CI gate verifying secrets history (`gitleaks`), agent hooks, dependency vulnerabilities (`pnpm audit --audit-level=high`), static security invariants (Electron window/CSP/fuses/dangerous sinks), release hygiene, LGPL licence verification (when native runtimes are present), and hostile-input fuzz/security test suites.

## 2. Threat Model & Trust Boundaries

### 2.1 Untrusted Inputs (Hostile by Default)
- **M3U playlists & `#EXTHTTP` / `#EXTVLCOPT` directives:** Arbitrary UTF-8/malformed bytes, inline `data:` artwork URIs, non-HTTP stream URLs (`file://`, `javascript:`, `data:`), prototype-polluting JSON keys (`__proto__`, `constructor`, `prototype`), CRLF header injection, and oversized lines.
- **XMLTV guides (plain, `.gz`, `.tar.gz`):** Unclosed comments/CDATA/PI/DOCTYPE tags (quadratic scan DoS), deeply nested elements, XXE/entity-expansion payloads, multi-member gzip bombs, and malformed numeric character references.
- **Xtream Codes JSON APIs:** Oversized or deeply nested JSON objects/arrays (`S.COMPOSITE`), malformed escapes/trailing commas, hostile stream/icon URLs, and server-supplied HTTP 30x redirects to third-party origins.
- **Playback stream redirects & headers:** Cross-origin redirects that could exfiltrate `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, or `X-Auth-Token` headers or credentials embedded in URLs.
- **Renderer / IPC boundaries (Desktop):** Renderer JS runs in an isolated Chromium sandbox (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`) and talks only to frozen `window.elv` preload bridges (`player` and `catalog`). Main and the catalog `utilityProcess` treat every IPC payload as untrusted.

### 2.2 Trust Boundaries & Security Invariants
1. **Credential Isolation:** Passwords, tokens, and stream credentials live exclusively in platform secure storage (`expo-secure-store` on mobile/TV, Electron `safeStorage` encrypted `0o600` file on desktop). Stream URLs are materialized at play time and never persisted to `catalog.db`, telemetry, or logs.
2. **Unified Redaction Contract (`@elv/domain` `redactUrl` / `redactText`):**
   - Strips URL userinfo (`user:pass@`), Xtream path credentials (`/live/<user>/<pass>/...`, `/movie/...`, `/series/...`, `/timeshift/...`), sensitive query parameters (all `CREDENTIAL_PARAMS`: `username`, `user`, `password`, `pass`, `token`, `auth`, `key`, `apikey`, `api_key`, `access_token`, `sig`, `signature`, `expires`, `e`, `st`, `hash`), and sensitive HTTP headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`) across `http(s)`, `rtsp(s)`, `rtmp(s)`, `tcp`, `tls`, `httpproxy`, `udp`, `rtp`, `ftp`, and `file` schemes.
   - Desktop `mpv/redact.ts` delegates to `@elv/domain`; SQLite open errors (`sqlite-open-retry.ts`) redact filesystem paths and URLs before surfacing `ElvError.detail`.
3. **Header & Redirect Scoping:**
   - `CREDENTIAL_HEADER_NAMES` in `@elv/domain` includes `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, and `x-auth-token` (full parity with `StreamHttp.kt`, `StreamHttp.swift`, and `m3u-headers.ts`).
   - `apps/tv-mobile/src/storage/http.ts` preserves `res.url` so native auto-redirected responses still carry their final URL for scheme and origin validation.
   - **Desktop `mpv` caveat (documented):** Custom non-`User-Agent`/`Referer` headers passed via `http-header-fields` are sent by libavformat; desktop isolates playback in an out-of-process `elv-mpv` child with `--no-config --ytdl=no --load-scripts=no --load-unsafe-playlists=no --autoload-files=no --tls-verify=yes --curl-enabled=no`, and credential headers are never persisted to argv or disk.
4. **Play-Time Scheme Allowlist (Defense-in-Depth):**
   - `packages/data/src/stream-resolver.ts` and Android `modules/engine-media3/.../LoadRequest.kt` reject dangerous non-playback schemes (`file:`, `javascript:`, `data:`, `blob:`, `content:`, `about:`) at play time, matching Apple `AetherEngine` (`MediaPlan.swift`) and Desktop IPC (`player-ipc.ts`).
5. **Prototype Pollution & Null-Prototype Dictionaries:**
   - `stream-resolver.ts` uses `setSafeHeader` (`Object.defineProperty`), `m3u-templating.ts` (`VarBook`) and `urlvars-store.ts` use null-prototype maps and strip `__proto__`/`constructor`/`prototype`, and `apps/desktop/src/shared/player-ipc.ts` `isRecord` rejects prototype-polluting own keys (matching `catalog-ipc-guards.ts`).
6. **Parser Linear-Time & Memory Bounds:**
   - XMLTV scanner (`xmltv.ts` + `xml-tokens.ts`) avoids `O(N^2)` rescans on unclosed `<!--`, `<![CDATA[`, `<?`, or `<!DOCTYPE` sequences by advancing past the unclosed introducer/bounded window in linear time (`O(N)`).
   - `XtreamJsonStreamParser` (`xtream-stream.ts`) caps composite object/array buffers (`MAX_COMPOSITE_BYTES = 1 MiB`) and nesting depth (`MAX_JSON_DEPTH = 64`), skipping or rejecting hostile payloads cleanly without stack overflow or unbounded RAM growth.
7. **Desktop Local Storage & Protocol Containment:**
   - `catalog-worker.ts` creates the database parent directory with `0o700` (when created) and hardens `catalog.db` (+ `-wal`/`-shm` sidecars) to `0o600` on POSIX platforms.
   - `app-protocol.ts` (`resolveAppFile`) verifies symlink containment with `realpath` when resolving unpacked files on disk.

## 3. Automated Pre-Release Security Gate (`pnpm gate security`)

`pnpm gate security [--ci] [--out <path>] [--skip-audit] [--artifact <path>...] [--android-manifest <path>...] [--apple-plist <path>...] [--gradle-deps <path>...] [--tv]` runs:
1. **Gitleaks rules self-test** (`scripts/test-gitleaks-rules.mjs`) and **git secret scan** (`gitleaks git --config .gitleaks.toml --redact --no-banner`, failing in `--ci` if `gitleaks` is absent, warning locally).
2. **Agent write-time guardrail tests** (`.agents/hooks/hooks.test.mjs`, `.claude/hooks/*.test.mjs`).
3. **Static security invariants scanner** over workspace source (`apps/`, `packages/`, `modules/`):
   - Verifies Electron `BrowserWindow` options enforce `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `electron-builder.yml` production fuses (`runAsNode: false`, `enableCookieEncryption: true`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`).
   - Verifies desktop CSP header (`serve-app.ts`) has no `unsafe-eval`.
   - Rejects dangerous sinks in production source (`eval(`, `new Function(`, `dangerouslySetInnerHTML`, `shell.openExternal(`) outside tests/allowlisted docs.
4. **Supply-chain dependency audit** (`pnpm audit --audit-level=high`, skipped only with explicit `--skip-audit`).
5. **Release hygiene checks** (`tools/src/release-hygiene.ts`) whenever `--artifact`, `--android-manifest`, `--apple-plist`, or `--gradle-deps` flags are supplied.
6. **LGPL native licence gate** (`tools/src/mpv/licence.ts` & `tools/src/ffmpeg-media3/licence.ts`) automatically whenever bundled runtimes are present under `apps/desktop/resources/mpv/` or `modules/engine-media3/android/libs/`.

`.github/workflows/security.yml` runs `pnpm gate security --ci` on every pull request and push to `main`, while preserving `actionlint` and `zizmor` on workflow changes and weekly schedule.

## 4. Verification

- Strict TDD unit tests across `packages/domain`, `packages/data`, `packages/sources`, `apps/desktop`, `apps/tv-mobile`, `modules/engine-media3`, and `tools`.
- Hostile-input fuzz suites (`packages/sources/src/security-fuzz.test.ts`, `packages/domain/src/http-security.test.ts`, `packages/data/src/security-fuzz.test.ts`).
- `pnpm check` (`11 passed, 0 failed`), `pnpm gate security --ci` (or `--skip-audit` only if offline; test real `pnpm gate security --ci`), Gradle `:elv-engine-media3:testDebugUnitTest`, and independent `Gemini 4 Neon (XHigh)` whole-branch security review (`VERDICT: PASS`).

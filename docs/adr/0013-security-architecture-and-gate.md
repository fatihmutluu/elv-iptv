# ADR 0013 — Security Architecture, Threat Model & Automated Security Gate

- **Status:** Accepted
- **Date:** 2026-11-22
- **Issue:** `#100`
- **Spec:** [Security architecture & gate spec](../superpowers/specs/2026-11-22-security-architecture-design.md)

## Context

ELV IPTV ingests untrusted third-party inputs (M3U playlists, XMLTV guides, gzip archives, Xtream JSON APIs, and arbitrary HTTP redirect chains) while holding user-provided credentials and rendering video across mobile, TV, and desktop platforms. Individual hardening fixes already existed per layer (Electron sandbox & fuses, `SecretStore`, manual HTTP redirects, XMLTV/M3U bounds, gitleaks, and agent hooks), but there was no unified redaction module in `@elv/domain`, several cross-layer parity gaps existed (credential headers, play-time scheme guards, prototype pollution in resolver/templating/player IPC, XMLTV `O(N^2)` unclosed markup, Xtream composite JSON depth/size bounds), and no single automated pre-release security gate existed to prevent regressions.

## Decision

Adopt a two-layer security architecture:

1. **Write-time invariants and shared primitives:**
   - Centralize URL and text credential redaction in `@elv/domain` (`redactUrl`, `redactText`) covering all playback/transport schemes (`http(s)`, `rtsp(s)`, `rtmp(s)`, `tcp`, `tls`, `httpproxy`, `udp`, `rtp`, `ftp`, `file`), all `CREDENTIAL_PARAMS`, and all credential headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`).
   - Enforce `CREDENTIAL_HEADER_NAMES` parity (`x-api-key`, `x-auth-token`), null-prototype/prototype-key guards across parser/data/IPC boundaries, play-time scheme allowlists (`http`/`https`) across data and native engines, bounded linear-time scanning in XMLTV and Xtream stream parsers, `0o700`/`0o600` local database permissions on POSIX desktop, and `realpath` containment in `app-protocol`.
   - Maintain write-time agent guardrails (`.agents/hooks/`, `.claude/hooks/`) blocking force-push, secret/key reads, and generated native edits.

2. **Verify-time automated security gate (`pnpm gate security`):**
   - Provide `pnpm gate security [--ci]` in `tools/bin/gate.ts` (`tools/src/gates/security-gate.ts`) uniting `gitleaks` rules + git history scan, agent hook tests, static security invariant checks (Electron window flags, fuses, CSP, dangerous sinks), `pnpm audit --audit-level=high`, release hygiene checks, and LGPL native licence checks when runtimes are installed.
   - Run `pnpm gate security --ci` in `.github/workflows/security.yml` on every pull request and push to `main` alongside `actionlint` and `zizmor`.

## Consequences

- Every platform and tool shares one canonical redaction implementation with deterministic test coverage.
- Hostile playlists, XMLTV files, and Xtream payloads are exercised continuously by dedicated fuzz suites in CI.
- Any accidental regression in Electron sandboxing, fuses, CSP, unsafe JS sinks, secrets, or high-severity dependencies fails `pnpm gate security` before release.

# 0015 Stalker / Ministra MAC Portal Sources

- Status: Accepted
- Date: 2026-11-24

## Context and problem

Foundation Spec §12 deferred Stalker/MAC portal support until `#29` is picked, asking us to weigh three protocol realities against ELV IPTV's core security and performance invariants:

1. **MAC-bound session handshakes:** Stalker/Ministra portals authenticate clients via a device MAC address (`Cookie: mac=<url-encoded>`) and mint short-lived bearer tokens via `action=handshake`.
2. **Ephemeral play-time `create_link` URLs:** Live channel and VOD catalog rows carry opaque portal command strings (`cmd`, often prefixed with `ffmpeg ` or `ffrt `) rather than stable stream URLs. Playable URLs expire rapidly (often within seconds/minutes) and MUST be minted on demand via `action=create_link`.
3. **Portal EPG and paginated VOD/series APIs:** Portals expose genres, paginated live/VOD/series lists (`get_ordered_list`), and portal EPG endpoints (`get_epg_info` / `get_short_epg`) rather than XMLTV files.

## Decision drivers

- **Zero credentials or MAC addresses in SQLite or logs:** Portal URLs, MAC addresses, optional serial/device identifiers, and bearer tokens must live strictly in platform `SecretStore` (and ephemeral in-memory session state), never in `catalog.db`, error payloads, or logs.
- **Atomic catalog and guide ingestion:** Stalker imports must reuse our staged shadow-table swap (`live_next`, `movies_next`, `series_next`, `categories_next`, `placements_next`, `programmes_next`) so mid-run network drops never corrupt live catalog tables.
- **Strict `max_connections` safety:** Play-time `create_link` mints fresh URLs strictly when tuning a stream inside `StreamResolver`, never storing expiring tokens or opening parallel stream sockets.
- **Deterministic simulator verification:** Live, guide, and VOD flows must be verified against synthetic Stalker endpoints in `tools/src/sim/` without external network dependencies.

## Decision outcome

We add `'stalker'` as a first-class `SourceKind` alongside `'m3u'` and `'xtream'`:

1. **Credential isolation (`SecretStore`):** `source.<id>.stalker` stores `{ portalUrl, mac, serialNumber? }` exclusively in `SecretStore`. SQLite `sources` holds only non-secret metadata (`id`, `kind = 'stalker'`, `name`, `settings_json` with non-reversible `credentialFingerprint` and `transport` options).
2. **Pure client in `@elv/sources`:** `createStalkerClient` handles endpoint resolution (`/portal.php` / `/server/load.php`), bearer token `handshake()`, single automatic token-expiry re-handshake retry, `get_profile`, genres/categories, paginated `get_ordered_list` for live/VOD/series, `get_epg_info`/`get_short_epg`, and play-time `create_link` (stripping `ffmpeg `/`ffrt ` command prefixes and validating `http(s)://` output).
3. **Catalog & EPG import in `@elv/data`:** `importStalker` streams categories, live channels (storing opaque portal channel IDs and non-secret command tokens in `provider_id` / `catchup_source_template` only when credential-free, or resolving via channel ID at play time), movies, and series through the existing atomic shadow-swap pipeline. `importGuide` ingests Stalker EPG windows into `programmes_next` when no custom XMLTV override is configured.
4. **Play-time resolution:** `PlaytimeResolverCache.resolveStream` caches a session-scoped `StalkerClient` per source (evicted on source mutation/delete) and calls `createLink` immediately before playback (returning a fresh `StreamRequest` with `headers` and per-source transport overrides). Catch-up playback uses the existing `buildCatchupUrl({ mode: 'stalker', ... })` path.
5. **Simulator fixtures:** `tools/src/sim/` serves synthetic Stalker portal routes backed by the existing deterministic simulator catalog and media routes so live, guide, and VOD tests run offline in CI.

## Consequences

- **Good:** Users with MAC-authenticated portals gain full live, EPG, VOD, series, and catch-up support without compromising ELV's zero-credentials-in-SQLite invariant.
- **Good:** Expiring stream tokens never rot in SQLite because `create_link` executes exclusively at play time.
- **Trade-off:** Portal quirks vary across Stalker/Ministra server versions; unknown response shapes fail cleanly with categorized `source-format` errors and can be iteratively hardened using simulator fixtures.

## Links

- Issue `#29` (Stalker portal sources)
- [Foundation design spec §12](../superpowers/specs/2026-11-13-foundation-design.md)
- [ADR 0005: Data layer](0005-data-layer.md)
- [ADR 0013: Security architecture and gate](0013-security-architecture-and-gate.md)

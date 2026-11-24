# playback (`@elv/playback`)

PlayerEngine contract, PlaybackService, recovery ladder and FakePlayerEngine.

## Commands
- `pnpm --filter @elv/playback typecheck` / `test` (or `pnpm -w check` for every repository check).

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports (ports live in `@elv/domain`).
- Source-first (`src/index.ts`, `./testing` -> `src/testing/index.ts`); allowed workspace dep: `domain`; tests `*.test.ts`.

## Public surface
- `PlayerEngine` port (`LoadCommand`, `LoadOptions.{bufferPreset,allowLegacyTls,secondarySubtitleTrackId,externalSubtitles,subtitleStyle}?`, `setScrubbing?`, `setSpeed?`, `selectAudioTrack?`, `selectSubtitleTrack?`, `selectSecondarySubtitleTrack?`, `addExternalSubtitle?`, `setSubtitleStyle?`, `ExternalSubtitleTrack`, `MediaTracks`,
  `TrackInfo`, `EMPTY_TRACKS`, `EngineEvent`, `EngineState`, `EngineCapabilities`, `AttemptToken`) and
  `bridgeNativeEngine`. `external-subtitles.ts` (`#308`, `#32`): `isAllowedExternalSubtitleUri`, `sanitizeExternalSubtitleHeaders` (strictly isolated from stream headers), `normalizeExternalSubtitleTrack`, `inferSubtitleMimeType`. `createMonotonicClock(nowFn?)` (`#159`);
  `positionAt(anchor, nowMs)` clamps to `[0, durationMs]`; `isAtLiveEdge(anchor, nowMs, toleranceMs)` applies the 5 s window (`#284`).
- `EngineError` / `toPlaybackError` / `classifyError(code, httpStatus?)`; `diagnosePlaybackFailure`, `extractRedactedHost`,
  and `createPlaybackDiagnoser({ clock, checkAccountHealth?, ttlMs? })` (`diagnoser.ts`, `#316`) classify failures with 60 s monotonic TTL caching and host-only redacted evidence.
- `@elv/playback/testing`: `createFakePlayerEngine({ scripts, now, schedule, cancel })` and `ENGINE_CONTRACT_CASES` (`contract.ts`).
- `createPlaybackService({ engine, clock, timers, config? })` (`service.ts`, `service-events.ts`, `state-store.ts`,
  `seek-coalescer.ts`, `speed-coalescer.ts`, `timeshift.ts`): `tune`, `retry`, `stop`, `play`, `pause`, `seek` (coalesced ~80 ms, guards stale clock ticks, clamps live time-shift seeks to `[liveSeekableStartMs, liveEdgeMs]`),
  `seekBy` (relative seek clamped to VOD duration or bounded live time-shift window; `#28`),
  `jumpToLiveEdge` (seeks directly to `liveEdgeMs` or `engine.jumpToLiveEdge` when `timeShiftSupported === true` and behind > 2 s, `#28`; or live MPEG-TS `liveEdgeMs - 3_000` when lagging > 4 s, `#141`),
  `setSpeed` (clamped `[0.25, 4.0]`, coalesced across active seeks and in-flight transitions; `#302`), `selectAudioTrack`,
  `selectSubtitleTrack` / `selectSecondarySubtitleTrack` (`track-preferences.ts`, `#151`, `#402`: enforces `primary !== secondary`, reconciles shifted IDs across reloads), `addExternalSubtitle` (`#308`, `#32`), `setSubtitleStyle` (live without restart, `#32`), `getState`, `subscribe`, `dispose`. `DEFAULT_PLAYBACK_CONFIG` holds spec timings; `timeshift.ts` exports `resolveLiveTimeShiftWindow`, `clampLiveSeekPosition`, `isBehindLiveEdge`, and `formatLiveOffset`.
- `createConnectionTracker()` (`connection-tracker.ts`, `#87`): pure per-`accountKey` connection tracker (`acquire`, `release`, `activeCount`, `activeStreamIds`, `checkLimit`) with non-double-counting `replacingStreamId` support for channel zaps.
- `createAbrHysteresisController({ rungs, clock, initialIndex?, config? })` (`abr-hysteresis.ts`, `#176`): pure clock-injected anti-oscillation ABR selector (`downgradeSafetyFactor=0.85`, `stepDownCooldownMs=5s` bypassed on severe rebuffer, single-step ascent with `upgradeSafetyFactor=1.35`, `stepUpCooldownMs=20s` restarted on rebuffers, `3` samples over `15s`, rejects `<= 0` bps samples, and full window/cooldown reset on `onPause`/`onBackground`/`onTune`/`reset`).

## Recovery (spec sections 5.4 and 5.5; `recovery.ts`, `ladder.ts`, `backoff.ts`, `stall-watchdog.ts`, always wired)
- Entry: a stall of 4 s while `playing` (deferred up to `maxStallDeferrals=3` windows while `progress` arrives; `#321`), rolling non-seek rebuffer stalls (`rollingRebufferThreshold=3` within `rollingRebufferWindowMs=120s` advancing cleanly to alternates when available; `#150`), a zero-decoded-frame black screen (`hasVideoTrack && decodedVideoFrames===0` with advancing `positionMs` for `zeroFrameWindowMs=4s` -> `'decoder'` escalation; `#321`), a frozen live clock (`positionMs` non-advancing for 4 s after first frame -> one bounded live-edge reload reset before escalating; `#148`), no `playing` 5 s after live `load` (8 s VOD, extended by advancing `progress` bytes up to `vodStartMaxTimeoutMs=30s`; `#314`), or a recoverable error. An unexpected live `ended` triggers one clean-end reload (`#148`; VOD untouched). Fast
  errors wait gaps 0, 1, 2, 4 s; silent timeouts escalate immediately (live tunes with no first frame skip rung 1) and
  each rung has 2 s to play (~9-11 s silent bound): 1 `retry`, 2 `load`, 3 `recreate` + `load` (incrementing `surfaceRecreationToken` only on `'decoder'` faults; `#144`), 4 software audio + HEVC/DV fallback (`preferHevcOverDolbyVision`, `#189`) or
  alternates (`stopMedia` before async resolve; iterates `TuneRequest.alternates` and inline `StreamRequest.alternates`,
  skipping failed resolvers and endpoints matching per-tune canonical `failedCanonicalUrls` across `url`, `finalUrl`, and
  `error.finalUrl`, `#287`) or container fallback; then `failed` + `stop`. 30 s of `playing` restores budgets and resets single-use live clean-end / frozen-clock flags (`#433`).
- Limit path (`http-429`, `http-509`, `connection-limit`, even while `paused`): `stop`, `limited { nextAtMs }`, wait
  2, 4, 8, then 15 s, `load`; past 60 s `failed(connection-limit)`. Same-account `tune`s are held until wait ends.
- VOD: reloads resume from last playing/seek position; `network` reconnects with backoff up to 120 s (paused time excluded).
- Pause drops pending rungs without resetting rung budget; `play` continues recovery. `surface-lost` waits for `surface`.
- Seam (internal `seam.ts`): `RecoveryHooks` + `ServiceControl`; tests use `createPlaybackServiceWith`.

## Engine contract (spec section 5.1)
- Commands are enqueue-and-return; results arrive as events echoing an `AttemptToken`. After a command with a newer
  token the engine tags later events of the current media with it. `load` starts a new media; the rest keep it.
- One media at a time: `load` closes every connection of the previous media before the first new request.
- Position never lives in React state; readers call `positionAt` on the latest `clock` anchor.

# engine-aether (`@elv/engine-aether`)

Apple-only Expo module (tvOS, iOS, iPadOS): the AetherEngine 7.66.1 `PlayerEngine` and its `AetherSurface` view (player core spec 6.2).

## Commands
- `pnpm --filter @elv/engine-aether typecheck` and `pnpm --filter @elv/engine-aether test` run TypeScript and Vitest checks.
- `swift test --package-path modules/engine-aether/ios` runs the pure Swift core suite (`ElvAetherCoreTests` on macOS).
- `sh modules/engine-aether/scripts/check-build.sh project|app|archive <path>` verifies the generated Xcode project, `.app` or `.xcarchive`.

## API & Threading (`src/index.ts`, `ios/Core/`, `ios/Engine/`)
- `createAetherEngine(): PlayerEngine | null` (`null` without `ElvEngineAether`) wraps a native `Engine` shared object (`EngineObject`) via `@elv/playback`'s `bridgeNativeEngine`; `release()` disposes it idempotently (`OnDestroy` and `sharedObjectDidRelease` also dispose live engines).
- `AetherSurface({ engine, style?, resizeMode?, testID? })` renders `AetherSurfaceView` bound to that native object (details in `VIEW.md`), or `null` when absent, foreign or released. `aetherEngineVersion()` returns `AetherEngine.version`.
- JS commands (`load`, `retry`, `play`, `pause`, `seek`, `stop`, `recreate`) lock a monotonic epoch + token in `EngineObject` and hop to `@MainActor` (`EngineMainDriver` -> `EngineCore` -> `AetherBackend`), fencing out superseded media events before `SharedObject.emit` (`onEngineEvent`, `atMs` from `ProcessInfo.processInfo.systemUptime * 1000`). `EngineCore` holds `weak` `sink`, `EngineObject.dispose()` retains `self` onto `@MainActor` for `finalTeardown`, and `IdleTimer` tracks `ObjectIdentifier(owner)` so `release()` never leaks playback or wake-lock state.
- `ios/Core/` imports `Foundation` only (`ElvAetherCore` + pod): `EngineCore`, `LiveTsReader`, `URLSessionTransport`, `ByteFifo`, `ConnectionGate`, `ResponseSniffing`, `MediaPlan`, `ErrorMapping`, `Redaction` and `StreamHttp`.

## Requests, Live TS Reader & Errors (`LiveTsReader`, `URLSessionTransport`, `ErrorMapping`)
- `.liveTs` opens through `LiveTsReader` (`IOReader`, forward-only `seek == -1`, `discImageProbeEnabled = false`) over one ephemeral `EngineHttpSession` per `EngineObject` (`httpMaximumConnectionsPerHost = 1`, no cache, 10 s request timeout, lock-serialized `suspend`/`resume`/`cancel`, origin-scoped redirect header stripping via `sanitizeRedirectRequest`), retaining itself in flight until async `didCompleteWithError` releases its gate slot.
- `ConnectionGate` (`open` for `.liveTs`, `waitForClosed` barrier for `.hls`, `.vod` and `.liveTs -> .playlist` HLS handoffs) waits up to 1,000 ms for older generations' requests to close plus a 25 ms CFNetwork socket-teardown settle window before opening a newer media (force-closing stragglers after 1,000 ms) so 1-connection providers see zero overlap across zaps, handoffs and stops during startup.
- `LiveTsReader.open()` sniffs status + up to 1,024 bytes (`classifyProgressive`, judging body bytes before `Content-Type` labels): non-2xx -> `http-<s>`; `#EXTM3U` body -> closes the GET and reloads the same URL as HLS in the same serial; non-empty printable UTF-8 without >= 3 TS sync bytes (or an empty 2xx with a notice `Content-Type`) -> `connection-limit` (`notice`); an empty 2xx otherwise -> transport EOF (`network`); >= 3 TS sync bytes -> `.custom(reader, formatHint: "mpegts")` with sniffed bytes delivered first via partial-read `ByteFifo` (suspends > 8 MiB, resumes < 4 MiB; avoids `AVIOReader`'s blocking 256 KiB first read). A mid-stream drop after >= 1 byte reconnects once after completion; a reader failure wins over the engine kind; VOD `.ended` before any frame or playback reports a `vodEndedBeforePlay` `network` error.
- `ELV_AETHER route=<videoRoute> open=<ms> audio=<audioDelivery>` logs once per load without any URL; `MappedError.detail` always uses `redactUrl`.

## Start Latency (`MediaPlan.loadOptions`, `Apple TV 4K (3rd generation)` Simulator, `3 x 30` Zaps)
- `.liveTs` sets Candidate C (`liveStartupGraceSeconds = 0`, `liveStartupSingleSegmentMinimumSeconds = 1.0`, `probesize = nil`, `maxAnalyzeDurationMicros = nil`), selected from the Task 7 matrix (`0` limit responses, `0 ms` overlap, `1` surface per run; Candidate C 10-min `--burst 0` soak: `0` stalls, `138.9 ms` drift, `254.4 -> 273.3 MB`; HLS guard: cold `300.2 ms`, warm p50/p95 `142.5 / 311.7 ms`):

| Candidate | `--burst 8` cold / warm p50 / zap p95 | `--burst 0` cold / warm p50 / zap p95 |
| --- | --- | --- |
| A (engine defaults) | `316.8 / 138.0 / 226.9 ms` | `~2,800 / 463.8 / 541.5 ms` (cold > 2 s) |
| B (`grace = 0`) | `356.6 / 138.3 / 227.7 ms` | `1,799.4 / 1,687.9 / 1,766.7 ms` |
| **C (`grace = 0, minSeg = 1.0`)** | **`289.9 / 137.0 / 218.1 ms`** | **`759.3 / 652.2 / 722.6 ms`** |
| D (`C + probesize 1 MiB, analyze 1.5 s`) | `366.6 / 123.9 / 251.3 ms` | `817.2 / 646.2 / 733.8 ms` |

## Playback, Radio & Build (`AetherBackend`, `ElvEngineAether.podspec`, `embed-frameworks.sh`, `with-aether-frameworks.ts`)
- `AetherBackend` (`+Subscriptions`) owns one `AetherEngine` (`backgroundPlaybackEnabled = false`), replaced on `recreate()`, gating Combine `.sink` handlers and `seek()` on `engineLoadSerial` (set right before `currentEngine.load(...)`, reset to `0` on `start`, `stopMedia`, `rebuild` and `dispose`). `stopMedia()` closes the reader and calls `stop(resetDisplayCriteria: false, finalTeardown: false)`; `dispose()` calls `stop(resetDisplayCriteria: true, finalTeardown: true)` and invalidates `EngineHttpSession`.
- Audio-only live MPEG-TS (radio): opening through `LiveTsReader` (`IOReader`) bypasses AetherEngine's bare-`AVPlayer` audio URL host (`AVFoundationErrorDomain -11850`) and plays through its libavcodec `AudioPlaybackHost` (`ELV_AETHER route=audio ... audio=decoded`). `EngineCore` emits `firstFrame` at the first `playing` of audio-only media (`videoSize == nil`) while keeping the surface shutter black under the OSD.
- Never link MPVKit, VLCKit or a second FFmpeg copy; AetherEngine is pinned at exact `7.66.1` with optional traits off. `with-aether-frameworks.ts` + `embed-frameworks.sh` copy, `lipo`-thin, sign and archive dSYMs for the nine dynamic LGPL `AetherLib*.framework` binaries (~11.0 MiB `tvos-arm64` / `ios-arm64`).

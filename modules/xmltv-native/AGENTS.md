# xmltv-native (`@elv/xmltv-native`)

Android (Kotlin) and Apple iOS/tvOS (Swift) Expo native module that streams HTTP(S) XMLTV feeds, transparently inflates gzip, parses XMLTV bytes off the JS thread, and stages rows into a dedicated temporary SQLite file (never opening `catalog.db`) so `op-sqlite` can `ATTACH` and copy into `programmes_next` on its own SQLite engine (`#478`).

## API (`src/index.ts`)
- `isNativeXmltvStagerAvailable(): boolean` — `false` on web or when `ElvXmltvNative` is absent.
- `stageXmltv(request: NativeXmltvStageRequest): Promise<NativeXmltvStageResult | null>` — returns `null` on web/Node or when unavailable; otherwise returns `'not-modified'`, `'http-error'` (status/retryable/code only; never URL/body), or `'staged'` with `stageDbPath`, channel metadata, per-channel staged counts, warning summary, and validators.
- `cancelXmltvStage(jobId: string): void` — cooperatively cancels an in-flight staging job (safe no-op when unavailable).
- `cleanupStageFile(path: string): void` — deletes a temporary `.xmltv-stage-<jobId>.db` file and sidecars (`-wal`, `-shm`, `-journal`); ignores any non-matching path.

## Native Implementations (Zero External Dependencies)
- **Android (`android/`, `ElvXmltvNativeModule.kt`, `NativeXmltvStager.kt`, `XmltvByteScanner.kt`):** `HttpURLConnection` (up to 5 redirects with cross-origin auth/cookie stripping, conditional validators, `1f 8b` / `Content-Encoding: gzip` streaming `GZIPInputStream`), 64 KiB byte-array XMLTV scanner, and a dedicated temp `SQLiteDatabase` (`PRAGMA journal_mode = OFF; synchronous = OFF; temp_store = MEMORY`) with compiled `SQLiteStatement` `INSERT OR REPLACE INTO programmes_next` in 2,500-row transactions (API 28+ / SQLite 3.22 compatible).
- **Apple (`ios/`, `ElvXmltvNativeModule.swift`, `Core/XmltvByteScanner.swift`, `Core/XmltvSqliteWriter.swift`, `Core/XmltvRedirectPolicy.swift`):** `URLSessionDataDelegate` chunk streaming (zero full-body buffering, cross-origin auth/cookie stripping), `zlib` (`inflateInit2_` `15 + 32`) streaming inflation with truncated-stream detection, `UnsafeBufferPointer<UInt8>` XMLTV scanner, and direct `libsqlite3` temp DB writer in 2,500-row transactions.
- Never log URLs, headers, or credentials in JS, Kotlin, or Swift.

## Rules & Tests
- Imports `expo-modules-core` only; platforms `android` & `apple` (`:elv-xmltv-native` / `ElvXmltvNative`).
- TS: `pnpm --filter @elv/xmltv-native test` & `pnpm --filter @elv/xmltv-native typecheck`.
- Android JVM tests: `XmltvByteScannerTest.kt` (`./gradlew :elv-xmltv-native:testDebugUnitTest`).
- Apple Swift tests: `ios/CoreTests/XmltvByteScannerTests.swift` (`swift test --package-path modules/xmltv-native/ios`).

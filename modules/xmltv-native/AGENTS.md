# xmltv-native (`@elv/xmltv-native`)

Android (Kotlin) and Apple iOS/tvOS (Swift) Expo native module that streams HTTP(S) XMLTV feeds, transparently inflates gzip, parses XMLTV bytes off the JS thread, and stages rows directly into SQLite `programmes_next` (`#478`).

## API (`src/index.ts`)
- `isNativeXmltvStagerAvailable(): boolean` — `false` on web or when `ElvXmltvNative` is absent.
- `stageXmltv(request: NativeXmltvStageRequest): Promise<NativeXmltvStageResult | null>` — returns `null` on web/Node or when unavailable; otherwise returns `'not-modified'`, `'http-error'` (status/retryable/code only; never URL/body), or `'staged'` with channel metadata, per-channel staged counts, warning summary, and validators.
- `cancelXmltvStage(jobId: string): void` — cooperatively cancels an in-flight staging job (safe no-op when unavailable).

## Native Implementations (Zero External Dependencies)
- **Android (`android/`, `ElvXmltvNativeModule.kt`, `NativeXmltvStager.kt`, `XmltvByteScanner.kt`):** `HttpURLConnection` (up to 5 redirects, conditional validators, `1f 8b` / `Content-Encoding: gzip` streaming `GZIPInputStream`), 64 KiB byte-array XMLTV scanner, and `SQLiteDatabase` + compiled `SQLiteStatement` `INSERT OR REPLACE INTO programmes_next` in 2,500-row WAL transactions (API 28+ / SQLite 3.22 compatible).
- **Apple (`ios/`, `ElvXmltvNativeModule.swift`, `Core/XmltvByteScanner.swift`, `Core/XmltvSqliteWriter.swift`):** `URLSessionDataDelegate` chunk streaming (zero full-body buffering), `zlib` (`inflateInit2_` `15 + 32`) streaming inflation, `UnsafeBufferPointer<UInt8>` XMLTV scanner, and direct `libsqlite3` prepared `INSERT OR REPLACE` in 2,500-row `BEGIN IMMEDIATE` transactions.
- Never log URLs, headers, or credentials in JS, Kotlin, or Swift.

## Rules & Tests
- Imports `expo-modules-core` only; platforms `android` & `apple` (`:elv-xmltv-native` / `ElvXmltvNative`).
- TS: `pnpm --filter @elv/xmltv-native test` & `pnpm --filter @elv/xmltv-native typecheck`.
- Android JVM tests: `XmltvByteScannerTest.kt` (`./gradlew :elv-xmltv-native:testDebugUnitTest`).
- Apple Swift tests: `ios/CoreTests/XmltvByteScannerTests.swift` (`swift test --package-path modules/xmltv-native/ios`).

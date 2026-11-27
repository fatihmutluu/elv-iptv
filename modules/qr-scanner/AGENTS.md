# qr-scanner (`@elv/qr-scanner`)

Android and Apple (iOS/iPadOS) Expo native module providing an in-app QR code camera scanner for handheld pairing (`#510`).

## API (`src/index.ts`)
- `isQrScannerAvailable(): boolean` — returns `false` on web, TV targets (`tvOS`, Android TV, Fire OS), desktop targets, or camera-less devices.
- `scanQrCode(): Promise<string | null>` — presents a full-screen dark camera QR scanner (`#0A0B0F`) and resolves the trimmed QR payload or `null` on cancel, denial, or unavailability.

## Native Implementation
- **Apple (`ios/`, `ElvQrScanner.podspec`, `ElvQrScannerModule.swift`):** `AVCaptureSession` + `AVCaptureMetadataOutput` (`[.qr]`) on iOS 18+, `#else` tvOS 18+ no-op stub with zero `AVCapture*` symbols.
- **Android (`android/`, `ElvQrScannerModule.kt`, `QrScannerActivity.kt`, `QrScannerDecoder.kt`):** AndroidX CameraX `1.4.2` + pure Java `com.google.zxing:core:3.5.3` (zero GMS, zero Firebase, zero MLKit); module manifest omits `CAMERA` permission so TV builds stay permission-free.

## Commands & Rules
- `pnpm --filter @elv/qr-scanner test` runs Vitest; `pnpm --filter @elv/qr-scanner typecheck` runs TypeScript.
- Imports `expo-modules-core` only; source-first (`exports` -> `./src/index.ts`).

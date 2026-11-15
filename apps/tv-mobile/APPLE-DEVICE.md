# Installing on Physical Apple Devices

Manual guide for building and installing the production `tv-mobile` app (`@elv/engine-aether`) onto a physical iPhone, iPad, or Apple TV from a macOS machine with Xcode installed.

## 1. Account Setup in Xcode

1. Open **Xcode** on the build Mac.
2. Open **Xcode → Settings… → Accounts**, click **+**, choose **Apple ID**, and sign in.
3. Select the account and note your **Team ID** (or inspect it via `security find-identity -v -p codesigning` once Xcode creates an Apple Development certificate).

## 2. Prepare the Device

### iPhone or iPad (iOS / iPadOS 18.0+)

1. Connect the iPhone or iPad to the Mac with a USB / USB-C cable and tap **Trust** when prompted on the device.
2. On the device, open **Settings → Privacy & Security → Developer Mode**, turn **Developer Mode** on, restart when prompted, and confirm after reboot.
3. Verify Xcode sees the device in **Xcode → Window → Devices and Simulators** or from a terminal:
   ```sh
   xcrun devicectl list devices
   ```
   Copy the **Identifier (UDID)** for `<device-udid>` below.

### Apple TV (tvOS 18.0+)

1. Ensure the Apple TV and the build Mac are on the same local network.
2. On the Apple TV, open **Settings → Remotes and Devices → Remote App and Devices** and stay on that screen.
3. On the Mac, open **Xcode → Window → Devices and Simulators**, select the discovered Apple TV in the left sidebar, and enter the pairing PIN shown on the TV screen.
4. Run `xcrun devicectl list devices` and copy the Apple TV's **Identifier (UDID)** for `<device-udid>`.

## 3. Prebuild, Sign, and Build

Run from the repository root on the Mac (plugged into AC power):

### iPhone or iPad

```sh
unset EXPO_TV
export APP_VARIANT=production
export STORE=direct

pnpm install --frozen-lockfile
(cd apps/tv-mobile && pnpm exec expo prebuild --clean --platform ios --no-install)
(cd apps/tv-mobile/ios && pod install)

ws=$(cd apps/tv-mobile/ios && ls -d ./*.xcworkspace | head -n 1 | sed 's|^\./||')
scheme=${ws%.xcworkspace}

xcodebuild \
  -workspace "apps/tv-mobile/ios/$ws" \
  -scheme "$scheme" \
  -configuration Release \
  -destination 'id=<device-udid>' \
  -derivedDataPath ./build/apple-ios \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<team-id> \
  CODE_SIGN_STYLE=Automatic \
  build
```

Install onto the connected iPhone or iPad:

```sh
xcrun devicectl device install app \
  --device <device-udid> \
  ./build/apple-ios/Build/Products/Release-iphoneos/ELVIPTV.app
```

### Apple TV

```sh
export EXPO_TV=1
export APP_VARIANT=production
export STORE=direct

pnpm install --frozen-lockfile
(cd apps/tv-mobile && pnpm exec expo prebuild --clean --platform ios --no-install)
(cd apps/tv-mobile/ios && pod install)

ws=$(cd apps/tv-mobile/ios && ls -d ./*.xcworkspace | head -n 1 | sed 's|^\./||')
scheme=${ws%.xcworkspace}

xcodebuild \
  -workspace "apps/tv-mobile/ios/$ws" \
  -scheme "$scheme" \
  -configuration Release \
  -destination 'id=<device-udid>' \
  -derivedDataPath ./build/apple-tvos \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<team-id> \
  CODE_SIGN_STYLE=Automatic \
  build
```

Install onto the paired Apple TV:

```sh
xcrun devicectl device install app \
  --device <device-udid> \
  ./build/apple-tvos/Build/Products/Release-appletvos/ELVIPTV.app
```

> **Note:** On first install with a Personal Team certificate, open **Settings → General → VPN & Device Management** on the device (or **Settings → General → Profiles** on Apple TV) and trust the developer profile before launching the app. If your Apple ID cannot register the default bundle identifier, append `PRODUCT_BUNDLE_IDENTIFIER=<reverse-dns-bundle-id>` to `xcodebuild`. Clean `apps/tv-mobile/ios` and `./build` afterwards (`rm -rf apps/tv-mobile/ios ./build`) so generated folders are never committed.

## 4. Personal-Team Limits & Nested Frameworks

- **7-day profile expiry:** Provisioning profiles issued to a free Apple ID ("Personal Team") expire after 7 days. Re-run `xcodebuild ... build` and `xcrun devicectl device install app` to refresh the signature in place without wiping app data.
- **App count cap:** Personal Teams allow at most 3 sideloaded apps per device at one time.
- **Nested dynamic frameworks:** `[ELV] Embed AetherEngine frameworks` (`modules/engine-aether/ios/embed-frameworks.sh`) strips headers, thins to `arm64`, and signs the nine dynamic `AetherLib*.framework` binaries inside `Frameworks/` before Xcode signs the outer `.app`. Full App Store Connect / TestFlight validation of the nested frameworks happens later under the paid developer account.

## 5. On-Device Verification Checklist

- [ ] **Cold launch:** App starts cleanly with no dynamic-linker (`dyld`) or code-signing abort.
- [ ] **Live MPEG-TS channel:** Video and audio start promptly; zapping between channels keeps the black shutter over the surface until the new channel's first frame renders (no stale frame flash) and triggers no provider connection-limit response.
- [ ] **Live HLS channel:** Plays smoothly and recovers within a few seconds after switching away from the app for ~5 seconds and returning.
- [ ] **VOD movie:** Starts cleanly, seeks forward and backward, pauses and resumes accurately, and advances the OSD clock smoothly.
- [ ] **Audio-only live MPEG-TS (radio):** Plays decoded audio cleanly while keeping the video shutter black beneath the OSD.
- [ ] **Screen wake lock:** Display / screensaver stays awake while video or audio is actively playing (or rebuffering after playback started) and returns to normal idle sleep once paused, stopped, or exited.

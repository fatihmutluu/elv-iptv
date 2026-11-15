# Source Management Screen, Dev Seeder, and Localization Foundation — Design

- Status: approved (owner delegated all development decisions until `0.1` ships)
- Date: 2026-11-15
- Issues: #71 (plain add/remove source screen) and #10 (dev-only `.env.local` first-launch seeder), plus the shared `@elv/i18n` and `useFormFactor()` foundations consumed by #71 and #13.
- Builds on: Foundation Spec (`2026-11-13-foundation-design.md` §4, §5.2, §5.3, §5.6–§5.8), Device Catalog Spec (`2026-11-14-device-catalog-design.md`), Desktop Catalog Spec (`2026-11-15-desktop-catalog-design.md`), ADR 0004 (focus core), ADR 0005 (data layer).

## 1. Why

Version `0.1` requires two ways to get a user's M3U or Xtream source onto every target platform (Android TV, Fire OS, Android phone/tablet, Apple TV, iPhone/iPad, Windows, and macOS):
1. **Production & manual testing (#71):** A deliberately plain, zero-chrome screen where the user adds an M3U URL or Xtream account (including pasted `get.php?username=…&password=…` links per Product Decision 17), sees live import progress or a specific actionable error, refreshes a source, or removes it (stopping any active stream that belongs to it and wiping its rows and secrets).
2. **Development builds (#10):** A dev-only first-launch seeder that provisions the developer's `.env.local` test source once without broadcasting `DEV_*` credentials over the local network via Metro's unauthenticated HTTP manifest or JS bundle, and with zero seeder code path in production builds.

Both #71 and the upcoming plain browse menu (#13) also require the repository's localization layer (`@elv/i18n` with English and Turkish `.po` catalogs selected from device locale) and form-factor hook (`useFormFactor()` in `@elv/ui-kit`). Building those two thin foundations cleanly here avoids throwaway hardcoded strings.

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Keep `@elv/i18n` 100% pure TypeScript (`@elv/domain` only; no `react`, `react-native`, `expo*`, `electron`, or `node:*`) over `@lingui/core` 6, with `.po` catalogs for English (`en`) and Turkish (`tr`), an `Intl.PluralRules` polyfill guard for Hermes, and pure `resolveLocale()` selection from device/system language tags.
- Provide `FormFactorProvider` / `useFormFactor()` (`'tv' | 'phone' | 'tablet' | 'desktop'`) and `I18nProvider` / `useI18n()` in `@elv/ui-kit`.
- Validate source inputs before network I/O so common user mistakes (missing `http://`/`https://` scheme, invalid port, pasting an M3U URL into Xtream server, pasting a `get.php` link into M3U) produce specific messages or automatic `get.php` conversion rather than generic auth/network failures.
- Map every post-import outcome — wrong credentials (`auth/*`), unreachable server (`network/*`), provider connection limit (`network/rate-limited`), malformed playlist/panel response (`source-format/*`), storage/encryption failure (`storage/*`), cancellation (`network/aborted`), and an imported source with zero items — to a distinct localized message and concrete next step.
- Support D-pad remote (`FocusStore` + `FocusRing` + `TextEntryBoundary` + `TvTextInput`), touch, and mouse/keyboard with deterministic semantic `testID`s on every focusable control.
- Deliver `.env.local` development credentials without LAN exposure on Metro and strip all seeder code and `DEV_*` markers from production artifacts (`release-hygiene.ts` enforced).

### Non-Goals (Deferred to Later Issues / Rounds)
- Visual styling, custom typography, icons, or channel logos (Round 2 design language).
- In-app language switcher (#16, Round 2 — `0.1` follows device/OS locale).
- Editing an existing source's credentials in place (remove + re-add suffices for `0.1`).
- Pre-import category filtering (Product Decision 18, Round 3).

### Anti-Goals
- Never expose `DEV_*` values in Metro's HTTP manifest (`extra.dev`) or in any JS bundle served over `:8081`.
- Never write credentials or tokenized URLs into `catalog.db`, logs, or error strings.
- Never fork screens by file suffix (`.tv.tsx`, `.web.tsx`); form-factor layout forks use `useFormFactor()` only.

## 3. Approaches Considered

### 3.1 Issue #10 — Dev Credential Transport Without Metro LAN Exposure
1. **Keep `extra.dev` in `buildAppConfig` and pass `--host localhost` to Metro:** Rejected. Physical iPhones and Wi-Fi Android TVs need LAN access to Metro for JS bundle loading during development, and `--host localhost` still exposes `extra.dev` to any local process querying `:8081`.
2. **Dedicated native Expo module (`@elv/dev-seed`) reading gitignored native files:** Rejected. Autolinking links workspace native modules into both development and production native builds unless custom Gradle/Podfile exclusions are maintained.
3. **Chosen — Native-debug-only `app.config` asset embed on mobile/TV + main-process `process.env` with compile-time dead-code elimination on desktop:**
   - In `apps/tv-mobile`, `expo-constants` embeds `app.config` into the native debug binary via `expo-constants/scripts/getAppConfig.js` (invoked locally by Gradle `createDebugExpoConfig` and Xcode `Bundle Expo Config` with `argv[5] === 'true'`). Metro (`@expo/cli`) never invokes `getAppConfig.js`.
   - `buildAppConfig` deletes `extra.dev` completely and emits `extra.seed` (using lowercase keys `kind`, `name`, `server`, `username`, `password`, `playlistUrl`) **only** when `env.APP_VARIANT === 'development'` **and** `options.embedDevSeed === true` (`isNativeDebugConfigEmbed(process.argv)`). Metro's manifest and JS bundle therefore carry zero credentials over the LAN.
   - `apps/tv-mobile/src/App.tsx` loads `./seed/dev-seeder` exclusively inside `if (__DEV__) { require('./seed/dev-seeder')... }`, which Metro constant-folds and omits from production/release JS/HBC bundles.
   - In `apps/desktop`, `scripts/bundle.mjs` sets esbuild `--define:__ELV_DEV_SEED__=true` only when `APP_VARIANT === 'development'` (`false` otherwise). Main reads `DEV_*` from its local `process.env` (never mapping them to the renderer), seeds via the catalog coordinator/worker when `!app.isPackaged`, and esbuild completely eliminates the seeder from production `dist/main/main.js`.
   - Both platforms persist `elv.dev.seeded = '1'` in `SecretStore` (`expo-secure-store` / `safeStorage`) so seeding runs at most once per install — even if the developer later tests removing the seeded source.
   - `tools/src/release-hygiene.ts` scans release bundles, `app.config`, and `app.asar` for `elv.dev.seeded` and `"seed":{` in addition to `DEV_*`, failing CI if any seeder path or payload ever leaks.

### 3.2 `@elv/i18n` Architecture
1. **`@lingui/react` inside `@elv/i18n`:** Rejected — violates `packages/i18n/AGENTS.md` ("Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports").
2. **Chosen — Pure `@lingui/core` + `.po` catalogs in `@elv/i18n`, thin React `I18nProvider`/`useI18n` in `@elv/ui-kit`:**
   - `packages/i18n/locales/{en,tr}/messages.po` hold standard PO catalogs compiled into typed pure-TS dictionaries (`src/locales/{en,tr}.ts`).
   - `@elv/i18n` wraps `@lingui/core`'s `setupI18n` behind a tiny typed `AppI18n` interface (`locale`, `setLocale`, `t`, `subscribe`) and installs `@formatjs/intl-pluralrules` (`en` + `tr`) only when `typeof Intl.PluralRules !== 'function'`.
   - `@elv/ui-kit` provides `I18nProvider` and `useI18n()` via `useSyncExternalStore`.

## 4. Detailed Design

### 4.1 `@elv/i18n` (`packages/i18n/`)
- `resolveLocale(candidates: readonly (string | null | undefined)[]): AppLocale`: iterates candidates in priority order, extracts the primary subtag (`tag.trim().split(/[-_]/)[0]?.toLowerCase()`), returns `'tr'` or `'en'` on the first match, and falls back to `'en'`.
- `ensurePluralRules()`: imports `@formatjs/intl-pluralrules/polyfill-force`? No — checks `if (typeof Intl === 'undefined' || typeof Intl.PluralRules !== 'function')` and loads `@formatjs/intl-pluralrules/polyfill` + `locale-data/en` + `locale-data/tr` so standard runtimes pay zero overhead while stripped Hermes runtimes stay spec-compliant.
- Message keys cover app header, form modes (`Xtream`, `M3U`), field labels/placeholders, `get.php` auto-detection notice + `Keep as M3U` toggle, transport settings (`User-Agent`, `Referer`, `MPEG-TS` / `HLS`), source row statuses (ready with live/movie/series counts, needs import, importing phase + count, cancelled), actions (`Add source`, `Import`, `Cancel`, `Refresh`, `Remove`), and every distinct validation/import error + actionable hint.
- Parity tests assert: (a) every key in `en` exists in `tr` and vice versa with non-empty text, (b) `{placeholder}` tokens match across `en` and `tr`, (c) Turkish characters (`İ`, `ı`, `ş`, `ğ`, `ü`, `ö`, `ç`) render intact, and (d) `resolveLocale` handles `['tr-TR']`, `['de-DE', 'tr']`, `['en-GB']`, `[]`, and malformed tags.

### 4.2 `@elv/ui-kit` (`packages/ui-kit/`)
- `src/form-factor.tsx`:
  - `export type FormFactor = 'tv' | 'phone' | 'tablet' | 'desktop';`
  - `detectFormFactor({ isTV, os, width, height })`: `'tv'` when `isTV`; `'desktop'` when `os === 'web'`; `'tablet'` when `Math.min(width, height) >= 600`; `'phone'` otherwise.
  - `FormFactorProvider({ value?, children })` + `useFormFactor()`.
- `src/i18n.tsx`:
  - `I18nProvider({ i18n, children })` + `useI18n(): AppI18n`.

### 4.3 `@elv/features` (`packages/features/`)
- `src/ports/playback-guard.ts`:
  - `export interface PlaybackGuard { stopIfUsingSource(sourceId: string): void | Promise<void>; }`
  - `noopPlaybackGuard`: default until #13 wires the active `PlaybackService` + current item's `sourceId`.
- `src/sources/validate.ts`:
  - `SourceFormState`:
    - `mode: 'xtream' | 'm3u'`
    - `name: string`
    - `server: string`, `username: string`, `password: string`, `xtreamFormat: 'default' | 'ts' | 'm3u8'`
    - `playlistUrl: string`, `keepAsM3u: boolean`
    - `guideUrl: string`, `userAgent: string`, `referer: string`
  - `validateSourceForm(form: SourceFormState): Result<ValidatedSourceSubmission, SourceValidationError>`:
    - Rejects control characters in any URL/header field (`invalid-characters`).
    - Validates HTTP(S) URL syntax (`missing-scheme` when `://` is absent on a non-empty address, `unsupported-scheme` when protocol is not `http:`/`https:`, `invalid-address` when URL parsing fails, hostname is empty, or explicit port is outside `1..65535`).
    - In `xtream` mode:
      - If `parseXtreamLink(form.server)` matches: extracts `{ server, username, password, output }` (using typed `form.username`/`form.password` if non-empty, else extracted credentials) so pasting a `get.php` link into Xtream Server works effortlessly.
      - If `form.server` has a path ending in `.m3u` / `.m3u8` (without `get.php` credentials): returns `m3u-in-xtream`.
      - Requires non-empty `username` and `password` (`missing-credentials`).
      - Defaults blank `name` to `new URL(normalizedServer).host`.
    - In `m3u` mode:
      - Requires non-empty `playlistUrl` (`missing-url`) with valid HTTP(S) address.
      - Defaults blank `name` to `new URL(playlistUrl).host`.
      - Submits as `{ kind: 'link', input: LinkSourceInput }` (honoring `keepAsM3u`), so `CatalogService.addSourceFromLink` converts `get.php` URLs to Xtream unless `keepAsM3u` is checked.
- `src/sources/errors.ts`:
  - `describeSourceFailure(error: ElvError): { messageId: MessageId; hintId: MessageId }`
  - `isEmptyImport(summary: ImportSummary): boolean`: returns `true` when `(summary.counts.live ?? 0) + (summary.counts.movies ?? 0) + (summary.counts.series ?? 0) === 0`, producing `source.error.emptyPlaylist` + `source.hint.emptyPlaylist`.
- `src/sources/useSourcesController.ts` & `src/sources/SourcesScreen.tsx`:
  - Loads `catalog.listSources()` on mount (and refreshes after dev seeder completion via an optional `seedReady` signal/callback).
  - Tracks per-source runtime state (`idle`, `importing` with `ImportProgress` + `AbortController`, `done` with `ImportSummary`, `error` with `{ messageId, hintId }`).
  - `submit()`: validates -> `addSource` or `addSourceFromLink` -> refreshes list -> immediately runs `importSource(row.id, { signal, onProgress })`.
  - `remove(id)`: calls `await playbackGuard.stopIfUsingSource(id)`, then `await catalog.removeSource(id)` (which aborts any active import of `id` first), removes per-source state, and refreshes `listSources()`.
  - Focus integration: wraps screen in `TextEntryBoundary`; on `tv` form factor, renders a hidden `<View focusable hasTVPreferredFocus>` parking anchor, opts buttons (`focusable={!isTv}`) and inactive text inputs (`editable` / `focusable` gated by `editingInputId`) out of native TV focus so D-pad never double-presses or traps in IME, supports `Left`/`Right` across horizontal button rows, scrolls focused controls into view, clamps `FocusStore` count synchronously, and wires `Back` (`blur` when editing, `onBack ?? onOpenMenu` otherwise). Every focusable element carries a stable `testID` and `accessibilityLabel`.

### 4.4 App Wiring & Dev Seeder (#10)
- **`apps/tv-mobile`:**
  - `config/build-app-config.ts`: exports `isNativeDebugConfigEmbed(argv: readonly string[]): boolean` (matching Gradle Android `argv[6] === 'development'` and Xcode iOS `argv[6] === 'development'` / legacy `argv[5] === 'true'`, while rejecting `'production'`, Metro, and `prebuild`) and `DevSeedPayload`; removes `extra.dev`; embeds `extra.seed` only when `development && options.embedDevSeed === true`.
  - `src/seed/dev-seeder.ts`: `normalizeSeedForTarget` rewrites `localhost`/`127.0.0.1` to `10.0.2.2` strictly on Android emulators (`isAndroidEmulator(Platform.OS, Platform.constants)`); `runDevSeedOnce({ seed, catalog, secrets })` checks `secrets.get('elv.dev.seeded')` and `catalog.listSources()`, adds and imports the source once, rolls back via `removeSource` without setting `elv.dev.seeded` if `importSource` fails with `category === 'network'`, and otherwise persists `'elv.dev.seeded' = '1'`.
  - `src/App.tsx`: when `gate === undefined`, resolves locale via `expo-localization` (`getLocales().map((l) => l.languageTag)`), opens a shared `createDeviceCatalog()`, runs `if (__DEV__)` dev seeder once, and renders `<FormFactorProvider><I18nProvider><SourcesScreen /></I18nProvider></FormFactorProvider>`.
- **`apps/desktop`:**
  - `scripts/bundle.mjs`: bundles `main.ts`, `preload.ts`, and `catalog-worker.ts` via esbuild API, defining `__ELV_DEV_SEED__: JSON.stringify(process.env.APP_VARIANT === 'development')`.
  - `src/main/catalog/dev-seed.ts` + `coordinator.ts`: when `__ELV_DEV_SEED__ && !app.isPackaged`, reads `DEV_XTREAM_*` / `DEV_M3U_URL` from `process.env`, checks `secretStore.get('elv.dev.seeded')`, seeds once through the catalog worker (rolling back on `category === 'network'` import failure), and broadcasts a secret-free `catalog:changed` IPC notification without ever sending `DEV_*` to the renderer.
  - `renderer/src/App.tsx`: when `!GATE`, resolves locale from `navigator.languages`, opens `createDesktopCatalog()`, subscribes to `window.elv.catalog.onChanged`, and mounts `<FormFactorProvider><I18nProvider><SourcesScreen /></I18nProvider></FormFactorProvider>`.

## 5. Testing Strategy
- `@elv/i18n` (Vitest, `>= 90%` coverage): catalog parity, placeholder parity, plural rules, `resolveLocale`, `createAppI18n` subscription.
- `@elv/ui-kit` (Jest): `detectFormFactor` & `useFormFactor` across TV, phone, tablet, desktop; `I18nProvider` & `useI18n` reactive updates.
- `@elv/features` (Vitest for `validate.ts` / `errors.ts` at `>= 90%` coverage + Jest RNTL for `SourcesScreen.tsx`):
  - Simulator integration tests against real `createSimServer` (`demo` Xtream, M3U URL, `get.php` paste conversion + `keepAsM3u`, wrong password -> distinct auth message, unreachable port -> distinct network message, empty account/playlist -> distinct empty message, remove source -> wipes rows and calls `playbackGuard.stopIfUsingSource`).
  - Form-factor render tests across `'tv'`, `'phone'`, `'tablet'`, and `'desktop'` verifying stable semantic `testID`s and D-pad focus + `TextEntryBoundary` behavior.
- `#10` Dev Seeder & Hygiene (Vitest):
  - `build-app-config.test.ts`: proves Metro argv, `expo prebuild` argv, Release `getAppConfig.js` (`argv[5] === 'false'`), and `APP_VARIANT=production` all omit `extra.seed` and `extra.dev`; proves Debug `getAppConfig.js` (`argv[5] === 'true'`) + `APP_VARIANT=development` embeds `extra.seed` with zero `DEV_*` key names.
  - `dev-seeder.test.ts` (`tv-mobile` & `desktop`): proves once-only seeding, preservation of non-renewal after `removeSource`, no-op when `listSources()` is non-empty, and inertness in production config.
  - `release-hygiene.test.ts`: proves `checkReleaseArtifactBuffer` flags `elv.dev.seeded` and `"seed":{` in addition to `DEV_*`.

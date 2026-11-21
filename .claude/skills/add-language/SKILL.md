---
name: add-language
description: Adds a new UI locale and translation catalog to @elv/i18n and wires it into device locale resolution and the in-app language picker. Use when adding support for a new application language.
---

# Add a UI language

Localization lives in `@elv/i18n` (pure TypeScript over `@lingui/core`, free of React, `react-native`, `expo*`, `electron`, `node:*`, and browser globals) and preserves strict key, `{placeholder}`, and `.po` parity across all catalogs (foundation spec section 5.7, UI/UX philosophy section 1).

## Steps
1. Pick a lowercase BCP 47 primary subtag `<code>` (for example `de`, `es`, `fr`) not yet present under `packages/i18n/src/locales/`.
2. Add the TypeScript catalog `packages/i18n/src/locales/<code>.ts` exporting `<code>Messages: Readonly<Record<MessageId, string>>` (importing `type { MessageId } from './en'`), translating every key from `enMessages`. Keep `{placeholder}` names identical and supply valid ICU plural forms for `<code>`.
3. Add `'settings.language.<code>'` (using the language's native endonym, e.g. `'Deutsch'`) to `packages/i18n/src/locales/en.ts`, `tr.ts`, `<code>.ts`, and every other `packages/i18n/src/locales/*.ts` catalog.
4. Create `packages/i18n/locales/<code>/messages.po` with `"Language: <code>\n"`, the matching `"Plural-Forms"` header, UTF-8 encoding, and exact `msgid` / `msgstr` parity with `<code>Messages`. Update `packages/i18n/locales/en/messages.po`, `tr/messages.po`, and any other `.po` catalogs with `'settings.language.<code>'`.
5. Wire the locale in `packages/i18n/`:
   - `src/i18n.ts`: import `<code>Messages`, append `'<code>'` to `SUPPORTED_LOCALES`, add `<code>: compileCatalog(<code>Messages)` to `COMPILED_CATALOGS`, pass it in `createAppI18n`'s `setupI18n({ messages })`, and match `primary === '<code>'` in `resolveLocale`.
   - `src/plural-polyfill.ts`: import `@formatjs/intl-pluralrules/locale-data/<code>.js` so runtimes without native `Intl.PluralRules` (such as Hermes) format `<code>` plurals cleanly.
   - `src/index.ts`: export `<code>Messages` from `./locales/<code>`.
   - `src/languages.ts`: check `LANGUAGE_MESSAGE_IDS` and `resolveLanguageLabel` if audio/subtitle track tags need `player.lang.<code>`.
6. Wire the in-app language picker and runtime surfaces (`PreferencesSnapshot.locale` in `packages/domain/src/preferences.ts` is already a generic short `string` defaulting to `'system'`):
   - `packages/features/src/settings/useTvSettingsNavigation.ts`: add `'lang-<code>'` to `AppearanceFocusId` and row 0 of `APPEARANCE_ROWS`.
   - `packages/features/src/settings/appearance-controls.ts`: append `{ id: '<code>', focusId: 'lang-<code>', testID: 'settings-lang-<code>', labelKey: 'settings.language.<code>' }` to `LANGUAGE_OPTIONS`, widen `activateAppearanceControl`'s `deps.setLocale` to `(locale: AppLocale) => void` if needed, and handle `'lang-<code>'`.
   - `packages/features/src/settings/AppearancePanel.tsx`: ensure the non-persisted `applyPatch` fallback accepts `'<code>'` (`SUPPORTED_LOCALES`).
   - Check `packages/features/src/player/track-labels.ts` (`isRedundantLabel`), `apps/desktop/renderer/src/workbench/WorkbenchInspector.tsx`, and directional/RTL layout if `<code>` is right-to-left.
7. Check `packages/data/src/fold.ts` (`foldText`): NFD combining-mark stripping, explicit Turkish `İ`/`ı` folding, and `ß` -> `ss` are already built in. Only add rules in `fold.ts` (and `fold.test.ts` idempotency tests) if `<code>` needs script-specific folding not covered by NFD + `.toLowerCase()`.
8. Practice strict TDD (`RED -> GREEN -> REFACTOR`):
   - Add tests first in `packages/i18n/src/i18n.test.ts` covering `SUPPORTED_LOCALES`, `resolveLocale`, `parsePoCatalog` / `extractPlaceholders` parity, `createAppI18n('<code>')`, plural forms, `ensurePluralRules`, and `'settings.language.<code>'`.
   - Add UI and TV D-pad coverage in `packages/features/src/settings/__tests__/SettingsScreen.test.tsx`.
   - Update `packages/i18n/AGENTS.md` (keep `<= 50` lines).
9. Verify with `pnpm --filter @elv/i18n test`, `pnpm --filter @elv/i18n typecheck`, `pnpm --filter @elv/features test:jest`, and `pnpm check` (`0 failed`).

## Do not
- Do not hardcode user-facing copy in components or add third-party brand names to any catalog.
- Do not leave `.ts` catalogs and `locales/<code>/messages.po` out of sync.
- Do not skip `@formatjs/intl-pluralrules/locale-data/<code>.js` in `packages/i18n/src/plural-polyfill.ts` or omit `'<code>'` from `resolveLocale`.
- Do not import `react`, `react-native`, `expo*`, `electron`, `node:*`, or browser globals inside `packages/i18n/`.

# 0006 State and i18n libraries

- Status: Accepted
- Date: 2026-11-13

## Context and problem

The app needs UI state, async data, small persisted preferences and two launch languages (English source, Turkish second), without putting high-frequency player progress into React state.

## Decision drivers

- Small footprint on TV hardware.
- Checked, mechanical language additions.
- Correct plurals on Hermes.

## Considered options

- Redux-style stores versus lightweight stores.
- Runtime i18n libraries versus Lingui compiled catalogs.

## Decision outcome

Zustand 5 for UI state, TanStack Query 5 for asynchronous reads, MMKV 4 for native key-value storage. Player progress stays out of React state (a mutable clock plus animated values). Lingui 6 with the `Intl.PluralRules` polyfill on Hermes; adding a language is one catalog file plus store texts; CI rejects hard-coded UI strings. Images use expo-image on native and a main-process proxy on desktop.

### Consequences

- Good: little boilerplate; fast re-renders; adding a language is cheap.
- Bad: polyfills are required on Hermes; pseudo-locale and directional-layout tests are needed from the start.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 4, 5.7.
- Research [13](../research/13-rn-data-state-ui-libs.md).

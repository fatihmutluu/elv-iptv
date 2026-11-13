# 0004 Own focus core and windowed lists

- Status: Accepted
- Date: 2026-11-13

## Context and problem

TV navigation with 100k+ item lists is the main risk of a React Native TV stack. Relying on native geometric focus over recycling lists produces the problems seen in reference apps.

## Decision drivers

- Remote key to highlight under 100 ms.
- Headless-testable focus behavior.
- 100k items without dropped frames on 1 GB devices.

## Considered options

- Native focus engines with stock lists.
- A JS-owned focus model with own TV lists.

## Decision outcome

A pure TypeScript focus core (`packages/focus-core`): focus as indices in scopes, focus memory, index resolvers and a Back stack, fed by one key source per runtime; native focus is used only at hand-off points. TV uses an own windowed list and EPG grid; LegendList sits behind an `ElvList` adapter for touch and mouse. Every focusable element has a stable semantic ID. Layout forks happen only through `useFormFactor()`.

### Consequences

- Good: focus survives list recycling and is unit-tested without a device.
- Bad: we maintain the focus core and lists; no published numbers exist for this approach, so the Round 1 gates must prove the budgets.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 4, 5.6, 6.2, 11.

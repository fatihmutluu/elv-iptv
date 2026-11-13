# 0010 Future TVs: Vega as a separate app, Tizen and webOS as web bundles

- Status: Accepted
- Date: 2026-11-13

## Context and problem

Fire TV devices running Vega OS cannot run Android APKs, and Samsung and LG TVs run web apps. These platforms are wanted later but must not distort Round 0.

## Decision drivers

- High reuse of packages and the focus core.
- Honest sequencing.
- No code before it is scheduled.

## Considered options

- Drop these platforms.
- Fork the UI per platform.
- Share packages and reuse the web bundle.

## Decision outcome

Vega gets a separate app that shares the pure packages (the Expo SDK does not target Vega), scheduled after Android TV and Fire OS are stable and tested on a Vega Virtual Device. Tizen and webOS become a web-TV app built from the react-native-web bundle that the desktop app already needs, Tizen first. Until scheduled, `apps/vega`, `apps/tizen` and `apps/webos` are folders with a README stating they are planned. Playback engines for these runtimes are chosen when the work is scheduled.

### Consequences

- Good: the design keeps packages portable; nothing is built prematurely.
- Bad: Vega cannot be tested on a Windows PC; web-TV playback is unproven until scheduled.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) section 2.

# 0002 Desktop with Electron, react-native-web and libmpv frame-copy

- Status: Accepted
- Date: 2026-11-13

## Context and problem

Windows, macOS and Linux should reuse the TypeScript UI. The hard problem on desktop is an interactive UI over video: native video surfaces cannot be composited by Chromium, so DOM overlays do not work over them.

## Decision drivers

- Reuse of UI code.
- DOM overlays (OSD, menus) over video.
- Crash isolation and a clean LGPL boundary.

## Considered options

- Electron + react-native-web with libmpv in a helper process, frames copied through shared memory to a WebGL canvas.
- Tauri v2.
- react-native-windows and react-native-macos.
- A native video surface under a transparent window.

## Decision outcome

Electron with a react-native-web renderer (a web-only Expo project). libmpv runs in a helper process and renders offscreen; frames reach a WebGL canvas through shared memory so DOM overlays work. better-sqlite3 runs in a utility process; electron-builder packages the app. The first proof gate (Round 1) is frame-copy plus a DOM OSD on Windows; the fallback is an external mpv window.

### Consequences

- Good: one UI codebase; crash isolation; OSD in the DOM.
- Bad: the frame-copy path is unproven in Electron with react-native-web; own LGPL libmpv and FFmpeg builds are a nontrivial native build burden; shared memory under the Mac App Store sandbox is unproven.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 2, 4, 11.

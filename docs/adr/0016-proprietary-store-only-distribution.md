# 0016 Proprietary license and official store-only distribution

- Status: Accepted (owner decision, Product Decision #41)
- Date: 2026-11-25
- Supersedes: [0012](0012-gpl-3-and-cla.md)

## Context and problem

ELV IPTV targets mainstream consumer app stores across TV, mobile, and desktop: Apple App Store (iOS, iPadOS, tvOS),
Mac App Store (macOS), Microsoft Store (Windows MSIX), Google Play (Android, Android TV / Google TV), and Amazon
Appstore (Fire OS). Shipping under `GPL-3.0-only` created two tensions:

1. App store distribution agreements (particularly Apple's App Store and Mac App Store terms) conflict with GPL-3.0
   redistribution requirements unless the copyright holder distributes under a separate proprietary license.
2. Keeping the application license `GPL-3.0-only` allowed third parties to repackage and sell competing builds of the
   codebase while ELV IPTV is preparing for official store launches.

The project still needs public GitHub Actions CI capacity for cross-platform builds and checks, and it must preserve
clean LGPL dynamic-linking compliance for its native media engines.

## Decision drivers

- Full compatibility with Apple App Store, Mac App Store, Microsoft Store, Google Play, and Amazon Appstore terms.
- Exclusive distribution through official app stores (no standalone `.exe` / `.dmg` direct-download installers).
- Continued access to public repository CI runners.
- Zero third-party GPL media libraries; preserve LGPL/MIT/Apache dynamic-linking compliance and offline Third-Party Notices.
- Keep the option to re-open-source the project in the future solely with the owner.

## Considered options

- Keep `GPL-3.0-only` with dual-licensed store binaries.
- Transition to a proprietary All Rights Reserved license with official store-only distribution while keeping the
  repository public for CI.
- Move the repository private immediately and forego public CI minutes.

## Decision outcome

ELV IPTV transitions to a proprietary, All Rights Reserved license (Product Decision #41):

- `LICENSE` states `Copyright (c) 2026 Fatih Mutlu. All Rights Reserved.`, notes that third-party open-source
  dependencies retain their respective upstream licenses (listed offline in the in-app Third-Party Notices screen), and
  confirms that native media engines dynamically link LGPL libraries only.
- The root manifest, `tools/package.json`, and every workspace `package.json` declare `"license": "UNLICENSED"`, and
  `tools/src/scaffold.ts` writes `"license": "UNLICENSED"` for new packages.
- All CocoaPods `.podspec` files declare `{ :type => 'Proprietary', :text => 'Copyright (c) ELV IPTV. All rights reserved.' }`.
- Official binaries are distributed exclusively via the Apple App Store, Mac App Store, Microsoft Store (MSIX), Google
  Play, and Amazon Appstore.
- The GitHub repository remains public for CI capacity; external code contributions are closed while the project is
  proprietary. `CLA.md` is retained as a historical record for prior commits, and `.github/workflows/cla.yml` remains
  enabled so required branch-protection checks stay green.
- Third-party LGPL, MIT, Apache-2.0, BSD, and OFL-1.1 components keep their upstream licenses, native engines
  dynamically link LGPL libraries only (zero third-party GPL components ship), and `pnpm check --only notices` remains
  enforced.
- Any future decision to re-open-source the codebase remains solely with the owner. Prior versions explicitly released
  under `GPL-3.0-only` remain available under that license as originally distributed.

### Consequences

- Good: Unambiguous store-policy compatibility across Apple, Microsoft, Google, and Amazon app stores.
- Good: Prevents unauthorized commercial repackaging while preserving public CI infrastructure.
- Good: Preserves clean LGPL dynamic-linking compliance and offline Third-Party Notices.
- Bad: External community code contributions are paused while the project is proprietary.

## Links

- [LICENSE](../../LICENSE), [CLA (archival)](../../CLA.md), [README](../../README.md#license).
- [Store compliance guide](../release/STORE_COMPLIANCE.md).
- [ADR 0012](0012-gpl-3-and-cla.md) (superseded).

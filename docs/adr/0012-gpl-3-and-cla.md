# 0012 GPL-3.0-only with the existing contributor license agreement

- Status: Superseded by [0016](0016-proprietary-store-only-distribution.md)
- Date: 2026-11-15
- Supersedes: [0008](0008-polyform-shield-and-cla.md)

## Context and problem

The project wants the IPTV community to build a free, solid player together. PolyForm Shield 1.0.0 is not an open
source license: its noncompete clause and the "source-available" label keep contributors away, and they leave people
unsure whether they may fork, package or modify the app. The owner still wants two things the old license gave:
nobody ships a closed, paid copy of the code, and the owner can relicense later.

## Decision drivers

- Contributors join an open project under a license they already know.
- Nobody can ship a closed, paid copy of the code.
- The owner keeps the freedom to relicense, including a commercial release.
- Store distribution stays possible.

## Considered options

- Keep PolyForm Shield 1.0.0 with the CLA.
- A permissive license with the CLA.
- GPL-3.0-only with the existing CLA.

## Decision outcome

GPL-3.0-only, with the official license text in `LICENSE` and `"license": "GPL-3.0-only"` in every workspace
manifest (the scaffolder writes it for new packages). The project is described as open source; the
"source-available" wording is retired. The CLA (version 1.0, adapted from the Apache ICLA) stays unchanged: it
already grants the owner the right to sublicense and relicense contributions. The README says this plainly: the code
is GPL-3.0, contributions come under the CLA, which allows the owner to relicense (including a commercial release),
and versions released under GPL-3.0 stay available under it.

Unchanged rules: third-party code keeps its own license; libmpv and FFmpeg are our own LGPL builds linked dynamically;
no third-party GPL component ships, because the owner cannot relicense code the CLA does not cover; implementers still
never read GPL or unlicensed reference sources, so every line in the repository comes from its author or from a
compatible license and the relicensing right stays clean. Legal review before the first store submission stays
deferred (foundation spec section 12).

### Consequences

- Good: an OSI-approved license that contributors and distributors understand; copyleft keeps every derivative open.
- Good: the CLA keeps a commercial edition or a store-specific license possible without asking every contributor.
- Bad: anyone may now build and sell a competing app from the code, as long as it stays GPL-3.0 with its source.
- Bad: the CLA gives the owner rights contributors do not get, which some contributors dislike; it still adds a step
  to the first pull request.
- Bad: some app stores add terms that conflict with the GPL; for our own code the owner's relicensing right covers
  this, which is one more reason no third-party GPL code ships.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) section 3.
- [LICENSE](../../LICENSE), [CLA](../../CLA.md), [README](../../README.md#license).

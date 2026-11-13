# 0008 PolyForm Shield 1.0.0 and a contributor license agreement

- Status: Accepted
- Date: 2026-11-13

## Context and problem

The code should be public and the app free for users, while protecting against competing products built from it. The owner must keep the freedom to publish a paid edition if community support is insufficient.

## Decision drivers

- Source visibility.
- Protection from competing commercial use.
- Freedom to relicense.

## Considered options

- A permissive license.
- A copyleft license.
- PolyForm Shield 1.0.0 with a CLA.

## Decision outcome

PolyForm Shield 1.0.0, described as "source-available". Contributors sign an Apache-style individual CLA by comment on their first PR, enforced by the CLA Assistant Lite action (step-security fork, pinned). The README pledge: free forever if the community supports development, otherwise a paid app. Third-party code keeps its own license; libmpv and FFmpeg are own LGPL builds linked dynamically; no GPL components ship; an in-app licenses screen is generated from dependencies. Legal review before the first store submission is deferred.

### Consequences

- Good: clear terms; relicensing is possible; contributors know the rules up front.
- Bad: not an OSI-approved license, which may deter some contributors; the CLA adds friction to a first PR.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 3, 12.
- [LICENSE](../../LICENSE), [CLA](../../CLA.md).

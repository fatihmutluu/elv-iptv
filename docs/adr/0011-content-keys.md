# 0011 Content keys keep distinct streams apart and drop only credentials

- Status: Accepted
- Date: 2026-11-13

## Context and problem

The catalog needs a stable identity per item so a refresh updates rows instead of duplicating them. The first
normalizer removed every query string and collapsed any three-segment path, so two different streams such as
`/play/index.m3u8?channel=7` and `?channel=8`, or `/live/<u>/<p>/news.m3u8` and `/live/<u>/<p>/sport.m3u8`, got the
same key and merged into one item. Credentials and rotating tokens must still never change a key or enter the database.

## Decision drivers

- Never merge two different streams.
- Credentials and tokens never appear in a key.
- Panels differ; the rule must be explainable in one paragraph.

## Considered options

- Drop the whole query and collapse every three-segment path (the first version).
- Keep the whole query.
- Drop only credential and token parameters, mask path credentials only in known Xtream shapes.

## Decision outcome

Xtream sources key by stream id (`xtreamKey`). M3U entries key by normalized URL plus name (`m3uKey`). The
normalizer lower-cases scheme and host, drops the default port, userinfo and fragment, removes query parameters whose
names are credentials or tokens (case-insensitive: `username`, `password`, `user`, `pass`, `pwd`, `token`, `auth`,
`key`, `signature`, `sig`, `expires`, `e`, `st`, `hash`) and keeps all others sorted by name. Path credentials become
`*` only in `/live|movie|series/<u>/<p>/<id>[.ext]` with a numeric id, in `/timeshift/<u>/<p>/...` and in the bare
three-segment `/<u>/<p>/<id>` form with a numeric id. An unparsable value loses anything that looks like userinfo.

Open question: panels also embed a token in the path (`https://host/<token>/<id>`) that may rotate on every refresh,
which would change the key each time. The import spec measures this against a real panel. If URLs prove unstable, M3U
keys fall back to name plus group.

### Consequences

- Good: distinct streams stay distinct; credentials never reach a key.
- Bad: a non-secret parameter that changes per refresh (for example a timestamp) changes the key; unknown token names
  are not recognized until added to the list.

## Links

- [Source scanners spec](../superpowers/specs/2026-11-13-source-scanners-design.md) section 5.1.

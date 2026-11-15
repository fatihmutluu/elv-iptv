# Vendored skill

- Source: https://github.com/callstackincubator/agent-skills, folder `skills/react-native-tv-best-practices`
- Commit: 59e9d17446a248b21d86f078fcd0bd2d36db1ca4 (2026-10-08)
- License: MIT, Copyright (c) 2026 Callstack Incubator (see `LICENSE`)
- Vendored on: 2026-11-13
- Local changes: one line added to `SKILL.md` right after the frontmatter, pointing agents to `PROJECT-NOTES.md` as the
  overriding project rules. No other upstream file changed; deviations live in PROJECT-NOTES.md.
- Not copied: `agents/openai.yaml` (Codex UI metadata; only Markdown was vendored).
- Frontmatter: loads as is (`name`, `description`, `license`); no change needed.
- Review: every file was read before copying; no scripts or binaries are included.
- Line endings: files are stored with LF (the Windows clone had CRLF); no other byte changes.

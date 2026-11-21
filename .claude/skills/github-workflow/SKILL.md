---
name: github-workflow
description: GitHub conventions for fatihmutluu/elv-iptv - issues, priority and cluster labels, Epics, the ELV IPTV Roadmap project, PRs, merging, and the private Ideas project. Use when creating or triaging issues, opening or merging PRs, moving board items, answering where are we, or capturing an idea.
---

# GitHub workflow

Repository: `fatihmutluu/elv-iptv`. Everything written to GitHub is English. Always request machine-readable output:
`gh ... --json <fields>` (on Windows PowerShell, prefer `| ConvertFrom-Json` or piping to `node -` over complex `--jq` expressions with quotes/braces, which PowerShell 5.1 splits). Never parse human tables.

## Issues
- Title is short and imperative. The body is English and ends with an `## Acceptance criteria` checklist.
- Labels: one `type:*`, at least one `area:*`, one primary `cluster:*` workstream label (so related bugs and features filter and batch cleanly in one PR), `platform:*` where it applies (including `platform:vega`, `platform:tizen`, `platform:webos`), one `priority:*` (`priority:critical`, `priority:high`, `priority:medium`, `priority:low`), one `effort:*` (`effort:s`, `effort:m`, `effort:l`, `effort:xl`), plus `good first issue` or `help wanted` when suitable. List the real set with `gh label list --repo fatihmutluu/elv-iptv --json name,description`.
- **Priority-Driven Backlog (No Version Milestones):** Do NOT create or use rigid version milestones (`0.1`, `0.2`, `0.3`, `Future`). Features and bugfixes are picked freely by priority and releases are cut whenever ready (owner decides release timing).
- **12 Workstream Cluster Labels (`cluster:*`):** `cluster:player-osd`, `cluster:desktop-mpv`, `cluster:android-media3`, `cluster:apple-aether`, `cluster:sources-data`, `cluster:epg-live`, `cluster:ui-browse-search`, `cluster:focus-remote`, `cluster:subtitles-audio`, `cluster:sync-profiles`, `cluster:security-ci`, `cluster:future-tv`. Before starting an issue, filter `is:open label:<cluster:*>` (and sort by `priority:critical` -> `high` -> `medium` -> `low`) to batch tightly coupled siblings cleanly.
- **Parent Epics & Native Sub-Issues:** Every non-epic open issue belongs to one Parent Epic (`#333`–`#349`) linked via GitHub's native Sub-Issues API (`gh api -X POST repos/fatihmutluu/elv-iptv/issues/<epic>/sub_issues -F sub_issue_id=<db_id>`) so progress rolls up automatically on Epics and the Roadmap board.
- Create: `gh issue create --repo fatihmutluu/elv-iptv --title ... --body-file ... --label ...`.

## Roadmap board
Public project "ELV IPTV Roadmap", Status: Backlog, Next, In progress, In review, Done. Never hard-code IDs; look them up:
- `gh project list --owner fatihmutluu --format json`
- `gh project field-list <number> --owner fatihmutluu --format json` for the Status field and option IDs.
- `gh project item-list <number> --owner fatihmutluu --format json` for items.
- Move an item: `gh project item-edit --id <item> --project-id <project> --field-id <status field> --single-select-option-id <option>`.
- If the project is unavailable to your token (for example an outside contributor fork), continue with labels and Epics only.

## Pull requests
- Branch from `main`, keep it short-lived. The PR title is a Conventional Commit; the body says why and links the issue
  (`Closes #n`). `main` is protected; merges are squash merges.
- Maintainer agents merge their own PRs only after CI passes: check with
  `gh pr checks <n> --repo fatihmutluu/elv-iptv --json name,state,bucket`, then `gh pr merge <n> --squash --delete-branch`. Outside contributors sign the CLA comment on their first PR and wait for maintainer review.
- Releases, tags and store builds wait for the owner. `gh release create`, `gh repo delete` and visibility changes
  ask for permission by design; never force-push.

## Where are we
Open issues grouped by priority (`priority:critical` / `priority:high` / `priority:medium` / `priority:low`), workstream `cluster:*`, and board status:
1. `gh issue list --repo fatihmutluu/elv-iptv --state open --limit 300 --json number,title,labels,assignees` (or filter by `--label "priority:critical"` / `--label "cluster:<name>"`)
2. Join with the board: `gh project item-list <number> --owner fatihmutluu --format json`.
3. Report counts per priority and board status, what is In progress or In review, and the next priority batch. Keep it to a few lines.

## Ideas (private)
The private "ELV IPTV Ideas" project holds maintainer draft items only. Add one with
`gh project item-create <ideas number> --owner fatihmutluu --title "<idea>" --body "<details>"`
(look the number up with `gh project list`), then mention it to the owner in one line. Never list, read or act on
Ideas items unless the owner asks. Ideas never become issues or work without the owner's approval.

## Models
Match Gemini model tier to task risk without ever compromising quality (never fall back to Claude models on quota limits — wait for Gemini quota renewal): frontier reasoning (`Gemini 4 Neon (XHigh)` / `Neon (High)`) for specs, plans, audits, native/concurrency code and whole-branch reviews; standard coding (`Gemini 4 Neon (Medium)`) for well-specified multi-file features and per-task reviews; scoped/mechanical (`Gemini 4 Neon (Low)` / `Hydrogen (XHigh)`) for tests, small fixes, CI/YAML and boilerplate; lightweight (`Gemini 3.8 Flash`) for read-only exploration and log/doc triage only.

---
name: github-workflow
description: GitHub conventions for fatihmutluu/elv-iptv - issues, labels, milestones, the ELV IPTV Roadmap project, PRs, merging, and the private Ideas project. Use when creating or triaging issues, opening or merging PRs, moving board items, answering where are we, or capturing an idea.
---

# GitHub workflow

Repository: `fatihmutluu/elv-iptv`. Everything written to GitHub is English. Always request machine-readable output:
`gh ... --json <fields>` (on Windows PowerShell, prefer `| ConvertFrom-Json` or piping to `node -` over complex `--jq` expressions with quotes/braces, which PowerShell 5.1 splits). Never parse human tables.

## Issues
- Title is short and imperative. The body is English and ends with an `## Acceptance criteria` checklist.
- Labels: one `type:*`, at least one `area:*`, `platform:*` where it applies (including `platform:vega`,
  `platform:tizen`, `platform:webos`), plus `good first issue` or `help wanted` when suitable. List the real set with
  `gh label list --repo fatihmutluu/elv-iptv --json name,description`.
- Milestones track versions (`0.1`, `0.2`, `0.3`, …). Every issue gets one: `gh api repos/fatihmutluu/elv-iptv/milestones`.
- Create: `gh issue create --repo fatihmutluu/elv-iptv --title ... --body-file ... --label ... --milestone ...`.

## Roadmap board
Public project "ELV IPTV Roadmap", Status: Backlog, Next, In progress, In review, Done. Never hard-code IDs; look them up:
- `gh project list --owner fatihmutluu --format json`
- `gh project field-list <number> --owner fatihmutluu --format json` for the Status field and option IDs.
- `gh project item-list <number> --owner fatihmutluu --format json` for items.
- Move an item: `gh project item-edit --id <item> --project-id <project> --field-id <status field> --single-select-option-id <option>`.
- If the project is unavailable to your token (for example an outside contributor fork), continue with labels and milestones only.

## Pull requests
- Branch from `main`, keep it short-lived. The PR title is a Conventional Commit; the body says why and links the issue
  (`Closes #n`). `main` is protected; merges are squash merges.
- Maintainer agents merge their own PRs only after CI passes: check with
  `gh pr checks <n> --repo fatihmutluu/elv-iptv --json name,state,bucket`, then `gh pr merge <n> --squash --delete-branch`. Outside contributors sign the CLA comment on their first PR and wait for maintainer review.
- Releases, tags and store builds wait for the owner. `gh release create`, `gh repo delete` and visibility changes
  ask for permission by design; never force-push.

## Where are we
Open issues of the current milestone, grouped by board status:
1. `gh issue list --repo fatihmutluu/elv-iptv --milestone "<milestone>" --state open --json number,title,labels,assignees`
2. Join with the board: `gh project item-list <number> --owner fatihmutluu --format json`.
3. Report counts per status, what is In progress or In review, and the next item. Keep it to a few lines.

## Ideas (private)
The private "ELV IPTV Ideas" project holds maintainer draft items only. Add one with
`gh project item-create <ideas number> --owner fatihmutluu --title "<idea>" --body "<details>"`
(look the number up with `gh project list`), then mention it to the owner in one line. Never list, read or act on
Ideas items unless the owner asks. Ideas never become issues or work without the owner's approval.

## Models
Match model tier to task risk: frontier reasoning (`Gemini 4 Carbon (High)` or `Claude Opus`) for specs, plans, audits, native/concurrency code and final reviews; standard coding (`Carbon (Medium)` or `Claude Sonnet`) for well-specified tasks and task reviews; mechanical (`Hydrogen (XHigh)`) for low-risk boilerplate; lightweight (`3.8 Flash` or `Claude Haiku`) for read-only log/doc triage only.

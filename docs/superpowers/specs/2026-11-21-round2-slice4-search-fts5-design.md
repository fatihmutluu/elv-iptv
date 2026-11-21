# Round 2 Slice 4 — Turkish-Aware FTS5 Search, 4+2 Top Bar & `add-language` Skill

**Date:** 2026-11-21  
**Status:** Approved for implementation (autonomous Round 2)  
**Design Contract:** [UI_UX_PHILOSOPHY.md](../../design/UI_UX_PHILOSOPHY.md) §2.1, §3, §4  
**Issues:** Closes #16

## 1. Goals & User Value
1. **Sub-50ms Turkish-Aware FTS5 Search (`@elv/data` + Electron IPC + `op-sqlite` FTS5):**
   - SQLite Migration v3 adds external-content FTS5 virtual tables (`live_fts`, `movies_fts`, `series_fts`, `content='<table>'`, `content_rowid='id'`, `tokenize='unicode61'`) over the pre-folded `name_fold` column (`foldText` with explicit Turkish `İ/ı/ş/ğ/ü/ö/ç` rules).
   - Zero duplicated string storage; `AFTER INSERT`, `AFTER DELETE`, and `AFTER UPDATE OF name_fold` triggers keep indexes synchronized automatically while skipping unchanged rows during bulk refreshes; Migration v3 runs `'rebuild'` so existing catalogs become searchable immediately without re-import.
   - Enables `"fts5": true` in `apps/tv-mobile/package.json` (`@op-engineering/op-sqlite` 19.0.5) so Android, Fire OS, iOS, iPadOS, and tvOS compile FTS5 natively.
   - `CatalogService.search(query, opts?)` folds user input via `foldText`, escapes/quotes tokens into safe prefix-AND FTS5 queries (immune to FTS5 operator injection), bounds results (`<= 60` per kind), and resolves M3U logos strictly at read time.
2. **Cinema Quietude `SearchScreen` & Canonical 4+2 Top Bar (`@elv/features/src/search/`, `AppShell.tsx`):**
   - Adds the `Search` utility icon (`nav-tab-search`) beside `Settings` (`nav-tab-settings`), completing the 4+2 top bar (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings`).
   - `150ms` debounced `TextEntryBoundary`-isolated input (`TvTextInput`), monotonic request-generation cancellation, scope `FilterChip`s (`All`, `Live`, `Movies`, `Series`) with `tabular-nums` hit counts, recent searches, decode-capped memoized Live (`WideCard`) & VOD (`PosterCard`) result grids, constructive empty states, and full 10-ft TV D-pad ergonomics.
3. **`add-language` Project Skill (`#16`):**
   - Documents the exact workflow for adding a new locale to `@elv/i18n` and `Settings` in `.claude/skills/add-language/SKILL.md` and `.agents/skills/add-language/SKILL.md`.

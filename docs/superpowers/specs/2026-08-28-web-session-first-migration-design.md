# Web Session-first Migration Design

**Date:** 2026-08-28  
**Status:** Approved  
**Requirements:** GitHub Issue [#472](https://github.com/BestNathan/nession/issues/472)  
**Parent:** [#468](https://github.com/BestNathan/nession/issues/468)  
**Depends on:** vertical slice [#471](https://github.com/BestNathan/nession/issues/471), tokens [#467](https://github.com/BestNathan/nession/issues/467), patterns [#470](https://github.com/BestNathan/nession/issues/470)

---

## Overview

Phase 4 Web: migrate remaining Dashboard capabilities into `SessionFirstShell`, make session-first the default entry, and retire Agent-first navigation. Incremental PRs to `staging`; flag stays **off** until the final cutover PR.

Architecture contracts: [`docs/design/`](../../design/README.md). Vertical slice spec: [`2026-08-27-session-first-vertical-slice-design.md`](2026-08-27-session-first-vertical-slice-design.md).

---

## Key Decisions

### 1. Incremental PRs with late default flip (strategy A)

**Decision:** Each PR adds capability to session-first while `isSessionFirst()` default remains off. Final PR sets default on and keeps legacy reachable via toggle until a follow-up removes Dashboard.

**Rationale:** Staging deploy safety; matches #471 flag pattern.

### 2. Reuse legacy dialogs and data hooks

**Decision:** `CreateSessionDialog`, `KillConfirmDialog`, `useDashboard` filter/modal state, and attach atoms — import into session-first shell; do not fork create/kill protocol.

**Rationale:** Lowest risk; #472 non-goals exclude protocol changes.

### 3. Session list sidebar owns lifecycle UX

**Decision:** Create, refresh, search/filter, sort, and per-row kill live in the session-first left rail (`SessionListHeader` + `SessionList` + `SessionItem`). No Agent grid.

**Rationale:** Session-first IA; Agent remains metadata on rows and in Workspace → Agent.

### 4. Kill clears local selection when needed

**Decision:** After successful kill, if the killed row was selected, clear `selectedId` in shell state; rely on `fetchSessions()` for server truth.

**Rationale:** Avoid dangling header/terminal for a dead session.

### 5. PR sequence

| PR | Scope |
|----|--------|
| **1 — Lifecycle** | Create/kill, search/filter/sort, refresh, loading/empty states |
| 2 — Global chrome | Header actions (env entry, errors, server info) |
| 3 — Terminal parity | Quick commands, attach-dialog edge cases |
| 4 — Workspace extensions | Claude Code in Agent tool |
| 5 — Deep links | `#/terminal/:id` in session-first |
| 6 — Mobile | Session-first terminal layout behaviors |
| 7 — Cutover | Default on; legacy deprecated |

This spec covers PR1 in detail; later PRs reference this doc.

---

## PR1: Session Lifecycle

### UI

```text
┌─ SessionListHeader ─────────────┐
│ SearchBar (reuse)               │
│ [Create] [Refresh]              │
├─────────────────────────────────┤
│ Sort: Name · Activity           │
│ SessionItem (+ kill btn)        │
│ …                               │
└─────────────────────────────────┘
```

- **Create:** `CreateSessionDialog`; disabled when no online agents (legacy rule).
- **Kill:** destructive icon on row; `stopPropagation`; opens `KillConfirmDialog`.
- **Search/filter:** reuse `SearchBar` + `useDashboard` `filteredSessions`.
- **Sort:** name / activity toggles in list header (legacy semantics).
- **Empty:** “No sessions” vs search miss copy (`SearchX`).

### Non-goals (PR1)

- Env manager, extensions, quick commands, deep links, default cutover.

### Testing

- Unit/component: SessionList kill/create wiring, search empty, sort.
- Integration: `SessionFirstShell` opens dialogs, create disabled offline.
- Playwright (PR comment): create flow smoke with `session_first=1`.

---

## Success criteria (#472 umbrella)

- [ ] Session-first is default Web entry (final PR)
- [ ] No primary nav path requires Agent → Sessions grouping
- [ ] Legacy Dashboard removed or zero default traffic
- [ ] `just web-lint` / `just web-test` / token lint on migrated surfaces
- [ ] PR1: daily create/kill/search flows work in session-first shell

---

## Non-goals (umbrella)

- App spatial model ([#473](https://github.com/BestNathan/nession/issues/473))
- Protocol / Rust changes
- New Workspace tools beyond existing slice set

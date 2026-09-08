# Web Session-first Migration PR1 — Session Lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session create/kill, search/filter/sort, and refresh to `SessionFirstShell` sidebar (PR1 of #472).

**Architecture:** Extend session-first patterns; wire `useDashboard` modal/filter state; reuse `CreateSessionDialog` / `KillConfirmDialog` / `SearchBar`.

**Tech Stack:** React, Jotai, Vitest, existing shadcn/ui primitives.

**Spec:** [`docs/superpowers/specs/2026-08-28-web-session-first-migration-design.md`](../specs/2026-08-28-web-session-first-migration-design.md)

---

## File map

| File | Role |
|------|------|
| `web/src/session-first/patterns/SessionListHeader.tsx` | Search, create, refresh |
| `web/src/session-first/patterns/SessionList.tsx` | Sort header, loading/empty, pass kill |
| `web/src/session-first/patterns/SessionItem.tsx` | Row kill button |
| `web/src/session-first/SessionFirstShell.tsx` | Wire dashboard + dialogs |
| `web/src/session-first/__tests__/integration/*.test.tsx` | Coverage |

---

### Task 1: SessionListHeader

**Files:**
- Create: `web/src/session-first/patterns/SessionListHeader.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionListHeader.test.tsx`

- [ ] Test: renders create (disabled when no online agents), refresh, search
- [ ] Implement header component reusing `SearchBar`, `RefreshButton`, `Button`

### Task 2: SessionItem kill action

**Files:**
- Modify: `web/src/session-first/patterns/SessionItem.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionItem.test.tsx`

- [ ] Test: kill button calls `onKill` without `onSelect`
- [ ] Add optional `onKill` with `stopPropagation`

### Task 3: SessionList sort / empty / loading

**Files:**
- Modify: `web/src/session-first/patterns/SessionList.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionList.test.tsx`

- [ ] Test: search-empty copy, sort toggle
- [ ] Add sort row, loading skeleton, search miss state

### Task 4: SessionFirstShell wiring

**Files:**
- Modify: `web/src/session-first/SessionFirstShell.tsx`
- Modify: `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx`

- [ ] Test: create opens dialog; kill opens confirm; uses filtered list
- [ ] Wire `useDashboard`, dialogs, clear selection on kill

### Task 5: Verify

- [ ] `just web-lint`
- [ ] `just web-test-unit` + integration for touched files
- [ ] Commit: `feat: add session lifecycle to session-first shell`

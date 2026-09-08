# App Spatial Shell (Issue #473) — Design

**Date:** 2026-08-29  
**Issue:** [#473](https://github.com/BestNathan/nession/issues/473)  
**Parent:** [#468](https://github.com/BestNathan/nession/issues/468) Phase 4 — App  
**Status:** Approved (brainstorming 2026-08-29)

## Goal

Ship the **App** interaction model from `docs/design/interaction/app.md` on **mobile Web** (not a native Capacitor/Tauri shell): when a session is selected under `session_first` on narrow viewports, navigate with a spatial pager

```text
Sessions  ←  Terminal  →  Workspace
```

instead of today’s list XOR detail chrome. Gestures are accelerators; visible header controls remain required.

## Locked decisions

| Topic | Decision |
|-------|----------|
| Platform | Pure mobile Web inside `web/` |
| No-session vs session | **Coexist:** no selection → existing full-width list; selection → spatial 3-page pager |
| Presentation | True 3-page horizontal pager (`Sessions \| Terminal \| Workspace`) |
| Gesture conflict | **Edge-only** shell swipes (≈24px from left/right viewport edge) |
| Visible controls | Terminal header: left **Sessions**, right **Workspace** (also reachable from other pages) |
| Implementation approach | **New** `AppSpatialShell` + `useEdgeSwipePager` — **do not modify** `SwipeableViewport` / `useSwipeGesture` |
| Flag / desktop | Only `session_first` + `max-lg`; desktop sidebar+main unchanged; do not flip default flag |
| Visual language | Keep #492 ChatGPT shell / capsule / tokens on the Terminal page |

## Non-goals

- Capacitor / Tauri / separate native app
- Replacing desktop session-first shell
- Changing legacy Agent-first `MobileTerminalLayout` ModeBar pager
- Expanding Workspace tool catalog
- Soft-keyboard `visualViewport` work
- Flipping `session_first` default (#472 PR7)

## Architecture

```text
session_first + max-lg + selectedId == null
  → existing SessionFirstSidebar list only (today’s list pane)

session_first + max-lg + selectedId != null
  → AppSpatialShell
       page 0 Sessions  — list UI (select / kill / filters); selecting a row jumps to page 1
       page 1 Terminal  — SessionHeader (spatial actions) + TerminalWell/capsule (default)
       page 2 Workspace — existing WorkspaceNavigation + tool panels

session_first + lg+
  → unchanged sidebar + main
```

Default pager index after selecting a session: **1 (Terminal)**. Deep-link restore with a session also lands on Terminal.

### New modules

| Module | Responsibility |
|--------|----------------|
| `web/src/session-first/app-spatial/useEdgeSwipePager.ts` | Touch handlers: only start shell drag if touch begins in left/right edge band; horizontal lock; index change on threshold |
| `web/src/session-first/app-spatial/AppSpatialShell.tsx` | Three full-height pages + transform track; wires header actions; syncs `activeIndex` ↔ `surface` |
| `web/src/session-first/app-spatial/AppSpatialHeaderActions.tsx` (or inline) | Sessions / Workspace icon buttons (≥44px) for Terminal header |

### Integration

- `SessionFirstWorkspace`: when `!isWide && selectedId`, render `AppSpatialShell` instead of the XOR `showList`/`showDetail` split.
- When `!isWide && !selectedId`, keep list-only.
- Preserve `useSessionFirstShellState` ownership of `selectedId`, `surface`, `tool`, file ops.
- Sync rules:
  - Pager → index 2 ⇒ `onSurfaceChange('workspace')`
  - Pager → index 1 ⇒ `onSurfaceChange('terminal')` (if currently workspace)
  - Pager → index 0 ⇒ stay on terminal surface semantically (list overlay page); do not require workspace tools
  - Header Sessions ⇒ index 0; Header Workspace ⇒ index 2 + `surface='workspace'`
  - `SurfaceSwitcher` on Terminal page may still switch terminal/workspace; when switching to workspace set index 2; when switching to terminal set index 1

### Session killed / cleared

If `selectedId` becomes null, unmount spatial shell and show list.

## Edge swipe behavior

- Edge band: **24px** from the physical left/right of the shell viewport (constant exported for tests).
- Touch start outside the band: ignore for shell pager (inner scroll/pan works).
- Direction lock: require horizontal dominance before dragging the track (same spirit as existing swipe hook, but **new code**).
- Commit threshold: ~50px or ~25% of page width (pick one; document in hook; tests lock it).
- `prefers-reduced-motion: reduce`: no rubber-band follow; buttons still change index instantly.

## Accessibility

- Sessions / Workspace controls: real `<button>`s with `aria-label`, min **44×44** hit targets.
- Each page has a way back to Terminal without gestures (Sessions page: selecting a session or an explicit “Open terminal” / auto-jump on select; Workspace: SurfaceSwitcher or header control).
- Do not rely on swipe alone to meet #468 App acceptance.

## Testing

- Unit: `useEdgeSwipePager` — edge vs non-edge start, threshold commit/cancel, index clamps, reduced-motion path if implemented.
- Component: `AppSpatialShell` — header buttons change page; select session from page 0 → page 1; workspace index syncs surface.
- Integration: `SessionFirstWorkspace` mobile — no session ⇒ no spatial shell; with session ⇒ spatial shell mounted; wide viewport never mounts spatial shell.
- Playwright (375): list → select → Terminal → Workspace via button → Sessions via button; attach screenshots on PR.
- Regression: existing `SwipeableViewport` / legacy mobile tests remain green without edits to those modules (except unrelated breakage).

## Success criteria (maps to #473)

- [ ] User can open Sessions, return to Terminal, open Workspace, use Files/Agent tools, return to Terminal without desktop layout on narrow `session_first`
- [ ] Visible non-gesture controls for Sessions and Workspace
- [ ] No edits to `SwipeableViewport.tsx` / `useSwipeGesture.ts`
- [ ] `session_first` default unchanged
- [ ] Lint/tests green; PR screenshots for 375 spatial shell

## Out of scope follow-ups

- #472 PR7 cutover  
- #400 rotation edge cases beyond not regressing current terminal resize  
- App experience token codegen (`experience.app.*`) — prefer existing `--sf-*` / semantic tokens already on session-first; do not introduce Web↔App token cross-lint violations

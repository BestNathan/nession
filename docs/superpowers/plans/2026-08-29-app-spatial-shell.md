# App Spatial Shell (#473) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `session_first` + narrow viewport + selected session, replace list XOR detail with an independent `Sessions | Terminal | Workspace` pager (edge swipes + header buttons), without touching legacy `SwipeableViewport`.

**Architecture:** New `web/src/session-first/app-spatial/` module (`useEdgeSwipePager`, `AppSpatialShell`) mounted from `SessionFirstWorkspace` when `!isWide && selectedId`. Reuse existing sidebar list content, `SessionFirstMain` terminal/workspace panels, and shell state. No changes to `SwipeableViewport` / `useSwipeGesture`.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Tailwind, existing session-first components.

**Spec:** `docs/superpowers/specs/2026-08-29-app-spatial-shell-design.md`  
**Issue:** #473  
**Base branch for code:** `origin/staging`  
**Branch:** `feat/app-spatial-shell`

---

## File map

| File | Role |
|------|------|
| Create `web/src/session-first/app-spatial/edgeBand.ts` | `EDGE_BAND_PX = 24` export |
| Create `web/src/session-first/app-spatial/useEdgeSwipePager.ts` | Edge-only swipe → page index |
| Create `web/src/session-first/app-spatial/__tests__/useEdgeSwipePager.test.ts` | Hook unit tests |
| Create `web/src/session-first/app-spatial/AppSpatialShell.tsx` | 3-page shell UI |
| Create `web/src/session-first/app-spatial/__tests__/AppSpatialShell.test.tsx` | Shell component tests |
| Modify `web/src/session-first/SessionFirstWorkspace.tsx` | Mount spatial shell on mobile+selection |
| Modify `web/src/session-first/patterns/SessionHeader.tsx` | Optional Sessions/Workspace actions (replace back-only on spatial) |
| Modify / add tests under `web/src/session-first/__tests__/` | Workspace integration |

---

### Task 1: `useEdgeSwipePager` (TDD)

**Files:**
- Create: `web/src/session-first/app-spatial/edgeBand.ts`
- Create: `web/src/session-first/app-spatial/useEdgeSwipePager.ts`
- Create: `web/src/session-first/app-spatial/__tests__/useEdgeSwipePager.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EDGE_BAND_PX } from '../edgeBand';
import { useEdgeSwipePager } from '../useEdgeSwipePager';

function startAt(x: number, y = 40) {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent;
}
function moveTo(x: number, y = 40) {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent;
}

describe('useEdgeSwipePager', () => {
  it('exports a 24px edge band', () => {
    expect(EDGE_BAND_PX).toBe(24);
  });

  it('ignores pans that do not start in an edge band', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({ pageCount: 3, index: 1, onIndexChange: onChange, width: 375 }),
    );
    act(() => {
      result.current.onTouchStart(startAt(187));
      result.current.onTouchMove(moveTo(80));
      result.current.onTouchEnd();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  it('commits to the left page when edge-dragging right past threshold', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({ pageCount: 3, index: 1, onIndexChange: onChange, width: 375 }),
    );
    act(() => {
      result.current.onTouchStart(startAt(10)); // left edge
      result.current.onTouchMove(moveTo(10 + 120));
      result.current.onTouchEnd();
    });
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('commits to the right page when edge-dragging left from right edge', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({ pageCount: 3, index: 1, onIndexChange: onChange, width: 375 }),
    );
    act(() => {
      result.current.onTouchStart(startAt(370));
      result.current.onTouchMove(moveTo(370 - 120));
      result.current.onTouchEnd();
    });
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('clamps index at ends', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({ pageCount: 3, index: 0, onIndexChange: onChange, width: 375 }),
    );
    act(() => {
      result.current.onTouchStart(startAt(10));
      result.current.onTouchMove(moveTo(200));
      result.current.onTouchEnd();
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL** (module missing)

```bash
cd web && npx vitest run src/session-first/app-spatial/__tests__/useEdgeSwipePager.test.ts
```

- [ ] **Step 3: Implement**

`edgeBand.ts`:
```ts
export const EDGE_BAND_PX = 24;
export const SWIPE_COMMIT_PX = 80;
```

`useEdgeSwipePager.ts` — controlled `index` / `onIndexChange`; track touch start x; activate only if `x <= EDGE_BAND_PX || x >= width - EDGE_BAND_PX`; update `dragOffset` while active; on end, if `|drag| >= SWIPE_COMMIT_PX` move index by sign (drag right → index-1); reset offset; ignore vertical-dominant moves (abs(dy) > abs(dx) early → cancel).

Return `{ dragOffset, isDragging, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel }`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/app-spatial/
git commit -m "$(cat <<'EOF'
feat(web): add edge-only swipe pager hook for App spatial shell

EOF
)"
```

---

### Task 2: `AppSpatialShell` UI

**Files:**
- Create: `web/src/session-first/app-spatial/AppSpatialShell.tsx`
- Create: `web/src/session-first/app-spatial/__tests__/AppSpatialShell.test.tsx`

- [ ] **Step 1: Failing component tests**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppSpatialShell } from '../AppSpatialShell';

describe('AppSpatialShell', () => {
  it('renders three pages and defaults to Terminal', () => {
    render(
      <AppSpatialShell
        sessions={<div>SESSIONS_PAGE</div>}
        terminal={<div>TERMINAL_PAGE</div>}
        workspace={<div>WORKSPACE_PAGE</div>}
        index={1}
        onIndexChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('app-spatial-shell')).toBeInTheDocument();
    expect(screen.getByTestId('app-spatial-page-terminal')).toBeInTheDocument();
  });

  it('header Sessions / Workspace buttons change index', async () => {
    const user = userEvent.setup();
    const onIndexChange = vi.fn();
    render(
      <AppSpatialShell
        sessions={<div />}
        terminal={<div />}
        workspace={<div />}
        index={1}
        onIndexChange={onIndexChange}
        showHeaderActions
      />,
    );
    await user.click(screen.getByTestId('app-spatial-open-sessions'));
    expect(onIndexChange).toHaveBeenCalledWith(0);
    await user.click(screen.getByTestId('app-spatial-open-workspace'));
    expect(onIndexChange).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `AppSpatialShell`**

- Root: `data-testid="app-spatial-shell"` `className="relative flex min-h-0 flex-1 flex-col overflow-hidden"`
- Measure width via ref + `ResizeObserver` (pass into hook)
- Track: `display:flex; width: 300%; transform: translateX(calc(-${index}*33.333% + drag))`
- Pages each `width: 33.333%` with testids `app-spatial-page-sessions|terminal|workspace`
- When `showHeaderActions`, render a top bar **or** accept `headerActions` slot — prefer rendering action buttons in a slim bar above children only if terminal doesn't already host them; **preferred API:** export buttons via render prop `renderTerminalChrome(actions)` OR put actions into Terminal page from parent. Simplest for this task: shell accepts optional `terminalHeaderActions` boolean and renders floating/safe top controls **over** the terminal page left/right.

Concrete preferred API for Task 3 wiring:

```tsx
export type SpatialPageIndex = 0 | 1 | 2;

export interface AppSpatialShellProps {
  sessions: React.ReactNode;
  terminal: React.ReactNode;
  workspace: React.ReactNode;
  index: SpatialPageIndex;
  onIndexChange: (index: SpatialPageIndex) => void;
  /** When true, overlays Sessions/Workspace icon buttons on the terminal page */
  showHeaderActions?: boolean;
}
```

Buttons: `PanelLeft` / `PanelRight` from lucide (or `Sessions` text), `size-11`, `data-testid="app-spatial-open-sessions"` / `app-spatial-open-workspace"`, `aria-label="Sessions"` / `"Workspace"`.

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(web): add AppSpatialShell three-page pager

EOF
)"
```

---

### Task 3: Wire `SessionFirstWorkspace` (mobile + selection)

**Files:**
- Modify: `web/src/session-first/SessionFirstWorkspace.tsx`
- Modify/create tests: `web/src/session-first/__tests__/SessionFirstWorkspace.test.tsx` (or nearby integration test)

**Context (staging):** Workspace currently uses `showList` / `showDetail` from `useSessionFirstMobileNav` to XOR sidebar vs main below `lg`.

- [ ] **Step 1: Failing test** — with `selectedId` set and viewport narrow (mock `useMediaQuery` / mobile nav `isWide: false`), expect `app-spatial-shell`; with `selectedId` null, expect no spatial shell; with wide, expect no spatial shell.

- [ ] **Step 2: Implement**

When `!isWide && selectedId`:
- Render `<AppSpatialShell index={spatialIndex} onIndexChange={...} showHeaderActions sessions={sidebarList} terminal={mainTerminalOnly} workspace={mainWorkspaceOnly} />`
- Do **not** also render the XOR sidebar/main pair.

When `!isWide && !selectedId`: keep list-only (existing sidebar visible).

When `isWide`: keep existing sidebar+main.

Maintain `spatialIndex` state in workspace or shell state hook:
- Initialize / reset to `1` when `selectedId` becomes non-null
- Selecting a session from Sessions page calls existing `onSelect` then `setSpatialIndex(1)`
- Sync with `surface`: if parent sets surface to `workspace`, set index `2`; if `terminal`, set index `1` (don't fight user on index `0`)

Clear selection path: existing clear → unmount shell.

**Important:** Split `SessionFirstMain` usage so Terminal page doesn't show workspace panel and Workspace page doesn't show terminal — pass a `spatialPage` prop or render two compositions:

```tsx
// Terminal page
<SessionFirstMain ... surface="terminal" onBackToSessions={undefined} spatialMode />
// Workspace page  
<SessionFirstMain ... surface="workspace" onBackToSessions={undefined} spatialMode />
```

Add optional `hideHeaderSwitcher?: boolean` only if SurfaceSwitcher conflicts; prefer keeping SurfaceSwitcher on terminal page and syncing index.

- [ ] **Step 3: Tests PASS + `cd web && npm test` relevant files**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(web): mount AppSpatialShell for session-first mobile selection

EOF
)"
```

---

### Task 4: Header UX polish + surface sync hardening

**Files:**
- Modify: `web/src/session-first/patterns/SessionHeader.tsx` and/or shell actions
- Tests for header

- [ ] **Step 1:** On spatial mobile Terminal page, **hide** the old `session-first-back-to-list` back chevron (XOR). Sessions is opened via `app-spatial-open-sessions` instead. Clearing selection still happens by… **keep a way to deselect**: from Sessions page, add or reuse overflow; OR keep a "All sessions" affordance on Sessions page that calls `onBackToSessions` / clear. Spec coexistence: Sessions page is the list — user can open another session; to exit to list-only mode, clearing selection can be "deselect" if product needs it — **implement:** Sessions page list is enough; killing active session clears selection (existing). Optional: long-press not required.

- [ ] **Step 2:** Ensure Workspace tools (Files) still work on page 2; internal horizontal scroll does not require shell swipe (edge-only already).

- [ ] **Step 3:** Unit/component tests updated; commit

```bash
git commit -m "$(cat <<'EOF'
feat(web): spatial header actions replace mobile XOR back button

EOF
)"
```

---

### Task 5: Quality gate + PR + Playwright

- [ ] **Step 1:** From feat worktree:

```bash
cd web && npm run lint && npx tsc --noEmit && npm test
```

- [ ] **Step 2:** Push `feat/app-spatial-shell`, open PR → `staging` (no `Closes #473` in body). Enable auto-merge rebase.

- [ ] **Step 3:** Local stack + Playwright at 375×812 with `session_first=1`: screenshot list, terminal page, workspace page, sessions page. Comment on PR.

- [ ] **Step 4:** After merge: remove `in-progress` from #473; comment progress (issue stays open until release `Closes`).

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Mobile web only | Tasks 3–5 |
| Coexist list / spatial | Task 3 |
| 3-page pager | Task 2 |
| Edge gestures | Task 1 |
| Header Sessions/Workspace | Tasks 2, 4 |
| New module, no SwipeableViewport edits | Tasks 1–2 |
| Flag default unchanged | Task 5 (verify) |
| Tests + screenshots | Tasks 1–5 |

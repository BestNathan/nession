# Mobile Scroll Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give touch devices explicit toolbar buttons to page through the xterm.js scrollback and jump back to the newest output (issue #240).

**Architecture:** `TerminalView` gains thin wrappers over xterm's `scrollLines`/`scrollPages`/`scrollToBottom`; the React `TerminalHandle` exposes them; a new `TerminalScrollOverlay` floating button group renders over the bottom-right of the terminal area in `MobileTerminalLayout` only (the mobile layout is CSS-hidden ≥1024px, so desktop viewports never see it). Callbacks are prop-drilled `TerminalWorkspace → TerminalLayout → MobileTerminalLayout`, mirroring the existing `sendText` path.

**Tech Stack:** React 19, xterm.js 5.5 (`terminal.scrollPages/scrollLines/scrollToBottom`), shadcn/ui Button + Tooltip, Vitest + Testing Library (jsdom).

**Design decisions (confirmed by user, 2026-08-14):**
1. Placement: floating vertical button group at the bottom-right of the terminal area, above the input bar. Existing quick-action toolbar row is NOT modified.
2. Button set: 3 buttons — page up `scrollPages(-1)`, page down `scrollPages(1)`, bottom `scrollToBottom()`.
3. Visibility gate: viewport-based only (mobile layout `<1024px`). Do NOT gate on `'ontouchstart' in window` — Playwright's desktop-mode Chromium at a 375px viewport reports no touch support, so a touch gate would break Success Criterion 1 (buttons must be visible/functional at 375px in Playwright).

**Key edge-case handling (from issue #240):**
- Boundary no-op: xterm's scroll APIs clamp at the buffer top/bottom — no extra state needed.
- Empty scrollback: same — APIs no-op.
- Focus stealing: every overlay button calls `e.preventDefault()` on `onPointerDown` so tapping never moves focus and the `MobileInput` textarea keeps it (on-screen keyboard stays open).
- Native touch scroll: the overlay is a sibling of the terminal element (NOT inside `TerminalView`'s internal `scrollContainer`), so its taps never reach the scrollContainer's tap-to-focus listeners and don't conflict with xterm's viewport touch scrolling.

**Coverage notes:** `web/src/terminal/TerminalView.ts`, `web/src/components/Terminal.tsx`, `web/src/components/TerminalLayout.tsx`, and `web/src/terminal/components/TerminalWorkspace.tsx` are all excluded from vitest coverage (see `web/vite.config.ts` `test.coverage` block) as browser-only glue — Tasks 1 and 3's glue changes are verified by `tsc`/`lint`/Playwright instead of unit tests. The new `TerminalScrollOverlay.tsx` and the new lines in `MobileTerminalLayout.tsx` ARE covered, so Task 2 and Task 3 include real unit tests.

**Execution context:** Run inside a worktree created via `EnterWorktree name: "feat/mobile-scroll-buttons"` (branch must keep the `feat/` prefix so CI triggers). Copy this plan file into the worktree and commit it with Task 1.

---

### Task 1: Expose scroll APIs on TerminalView / TerminalHandle

**Files:**
- Modify: `web/src/terminal/TerminalView.ts` (add methods after `sendText`, ~line 223)
- Modify: `web/src/terminal/types.ts:46-53` (`TerminalHandle` interface)
- Modify: `web/src/components/Terminal.tsx:345-364` (`useImperativeHandle`)

No unit tests for this task — all three files are coverage-excluded browser-only glue (see Coverage notes). Verified by `tsc` + Playwright (Task 5).

- [ ] **Step 1: Add scroll methods to TerminalView**

In `web/src/terminal/TerminalView.ts`, insert after the `sendText` method (after line 223):

```ts
  /** Scroll the scrollback buffer by whole pages (negative = towards history). */
  scrollPages(pages: number): void {
    if (this.isDisposed) { return; }
    this.terminal.scrollPages(pages);
  }

  /** Scroll the scrollback buffer by lines (negative = towards history). */
  scrollLines(lines: number): void {
    if (this.isDisposed) { return; }
    this.terminal.scrollLines(lines);
  }

  /** Jump the viewport to the newest output (bottom of the scrollback). */
  scrollToBottom(): void {
    if (this.isDisposed) { return; }
    this.terminal.scrollToBottom();
  }
```

- [ ] **Step 2: Extend TerminalHandle**

In `web/src/terminal/types.ts`, extend `TerminalHandle` (after `sendResize`):

```ts
  /** Scroll scrollback by pages (negative = towards history). */
  scrollPages: (pages: number) => void;
  /** Scroll scrollback by lines (negative = towards history). */
  scrollLines: (lines: number) => void;
  /** Jump the viewport to the bottom of the scrollback. */
  scrollToBottom: () => void;
```

- [ ] **Step 3: Expose on the React imperative handle**

In `web/src/components/Terminal.tsx`, inside `useImperativeHandle` (after the `sendResize` entry):

```ts
        scrollPages: (pages: number) => { viewRef.current?.scrollPages(pages); },
        scrollLines: (lines: number) => { viewRef.current?.scrollLines(lines); },
        scrollToBottom: () => { viewRef.current?.scrollToBottom(); },
```

- [ ] **Step 4: Verify compile + lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/TerminalView.ts web/src/terminal/types.ts web/src/components/Terminal.tsx docs/superpowers/plans/2026-08-14-mobile-scroll-buttons.md
git commit -m "feat: expose scrollLines/scrollPages/scrollToBottom on TerminalHandle"
```

---

### Task 2: TerminalScrollOverlay component (TDD)

**Files:**
- Create: `web/src/components/TerminalScrollOverlay.tsx`
- Test: `web/src/components/__tests__/TerminalScrollOverlay.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/__tests__/TerminalScrollOverlay.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalScrollOverlay } from '../TerminalScrollOverlay';

function setup() {
  const onScrollPages = vi.fn();
  const onScrollToBottom = vi.fn();
  render(
    <TerminalScrollOverlay
      onScrollPages={onScrollPages}
      onScrollToBottom={onScrollToBottom}
    />,
  );
  return { onScrollPages, onScrollToBottom };
}

describe('TerminalScrollOverlay', () => {
  it('renders page-up, page-down and scroll-to-bottom buttons', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Scroll up one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll down one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('page-up scrolls back one page', () => {
    const { onScrollPages } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll up one page' }));
    expect(onScrollPages).toHaveBeenCalledWith(-1);
  });

  it('page-down scrolls forward one page', () => {
    const { onScrollPages } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll down one page' }));
    expect(onScrollPages).toHaveBeenCalledWith(1);
  });

  it('bottom button jumps to the newest output', () => {
    const { onScrollToBottom } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('prevents pointerdown default so taps do not steal keyboard focus', () => {
    // fireEvent returns false when a cancelable event's preventDefault was
    // called — this is exactly the focus-steal guard we need on touch.
    setup();
    const up = fireEvent.pointerDown(screen.getByRole('button', { name: 'Scroll up one page' }));
    const down = fireEvent.pointerDown(screen.getByRole('button', { name: 'Scroll down one page' }));
    const bottom = fireEvent.pointerDown(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(up).toBe(false);
    expect(down).toBe(false);
    expect(bottom).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/TerminalScrollOverlay.test.tsx`
Expected: FAIL — cannot resolve `../TerminalScrollOverlay`.

- [ ] **Step 3: Write the component**

Create `web/src/components/TerminalScrollOverlay.tsx`:

```tsx
import { ChevronUp, ChevronDown, ArrowDownToLine } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface TerminalScrollOverlayProps {
  /** Scroll the terminal scrollback by pages (negative = towards history). */
  onScrollPages: (pages: number) => void;
  /** Jump the terminal viewport to the newest output. */
  onScrollToBottom: () => void;
}

/**
 * Floating scroll controls pinned to the bottom-right of the terminal area
 * (mobile layout only — the desktop layout never mounts this component).
 * Touch devices have no scroll wheel, so these buttons are the explicit way
 * to page through xterm's scrollback and return to the newest output.
 *
 * Every button calls preventDefault() on pointerdown so tapping never moves
 * focus — the MobileInput textarea keeps focus and the on-screen keyboard
 * stays open. xterm's scroll APIs clamp at the buffer boundaries, so no
 * disabled state or extra clamping is needed here.
 */
export function TerminalScrollOverlay({
  onScrollPages,
  onScrollToBottom,
}: TerminalScrollOverlayProps) {
  return (
    <div className="absolute bottom-2 right-2 z-10 flex flex-col gap-0.5 rounded-lg border bg-background/80 backdrop-blur-sm p-1 shadow-md">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="Scroll up one page"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onScrollPages(-1)}
            >
              <ChevronUp className="size-4" data-icon />
            </Button>
          }
        />
        <TooltipContent side="left">
          <p>Page up</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="Scroll down one page"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onScrollPages(1)}
            >
              <ChevronDown className="size-4" data-icon />
            </Button>
          }
        />
        <TooltipContent side="left">
          <p>Page down</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="Scroll to bottom"
              onPointerDown={(e) => e.preventDefault()}
              onClick={onScrollToBottom}
            >
              <ArrowDownToLine className="size-4" data-icon />
            </Button>
          }
        />
        <TooltipContent side="left">
          <p>Newest output</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/TerminalScrollOverlay.test.tsx`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TerminalScrollOverlay.tsx web/src/components/__tests__/TerminalScrollOverlay.test.tsx
git commit -m "feat: add TerminalScrollOverlay floating scroll controls"
```

---

### Task 3: Wire overlay into the mobile layout (TDD for MobileTerminalLayout)

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx` (props interface ~line 17, panel 0 ~line 335, imports line 1)
- Modify: `web/src/components/TerminalLayout.tsx` (props interface ~line 13, MobileTerminalLayout usage ~line 100)
- Modify: `web/src/terminal/components/TerminalWorkspace.tsx:243-253` (TerminalLayout usage)
- Test: `web/src/components/__tests__/MobileTerminalLayout.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `web/src/components/__tests__/MobileTerminalLayout.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileTerminalLayout } from '../MobileTerminalLayout';

// Heavy children are coverage-excluded components with WebSocket/DOM deps —
// stub them so this test stays focused on the layout wiring.
vi.mock('../env/EnvPanel', () => ({ EnvPanel: () => <div data-testid="env-panel" /> }));
vi.mock('../FileBrowser', () => ({ FileBrowser: () => <div data-testid="file-browser" /> }));
vi.mock('../FileViewer', () => ({ FileViewer: () => <div data-testid="file-viewer" /> }));

function setup() {
  const onScrollPages = vi.fn();
  const onScrollToBottom = vi.fn();
  render(
    <MobileTerminalLayout
      terminalElement={<div data-testid="terminal" />}
      sessionId="session-1"
      sendText={vi.fn()}
      toolbarDisabled={false}
      onScrollPages={onScrollPages}
      onScrollToBottom={onScrollToBottom}
    />,
  );
  return { onScrollPages, onScrollToBottom };
}

describe('MobileTerminalLayout', () => {
  it('renders the scroll overlay over the terminal panel', () => {
    setup();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll up one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll down one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('overlay taps invoke the scroll callbacks', () => {
    const { onScrollPages, onScrollToBottom } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll up one page' }));
    expect(onScrollPages).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/MobileTerminalLayout.test.tsx`
Expected: FAIL — TS error / runtime error: `onScrollPages` is not a valid prop, buttons not found.

- [ ] **Step 3: Add props to MobileTerminalLayout and mount the overlay**

In `web/src/components/MobileTerminalLayout.tsx`:

Add import (with the other component imports near the top):

```ts
import { TerminalScrollOverlay } from './TerminalScrollOverlay';
```

Extend `MobileTerminalLayoutProps` (after `sendText`):

```ts
  /** Scroll the terminal scrollback by pages (negative = towards history). */
  onScrollPages: (pages: number) => void;
  /** Jump the terminal viewport to the newest output. */
  onScrollToBottom: () => void;
```

Destructure the new props in the `MobileTerminalLayout` function signature and mount the overlay inside panel 0's terminal wrapper (the wrapper is already `relative`):

```tsx
    // Panel 0: Terminal
    <div key="terminal" className="h-full flex flex-col">
      {terminalElement ? (
        <div className="flex-1 min-h-0 relative flex flex-col">
          {terminalElement}
          <TerminalScrollOverlay
            onScrollPages={onScrollPages}
            onScrollToBottom={onScrollToBottom}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0" />
      )}
```

- [ ] **Step 4: Thread the props through TerminalLayout**

In `web/src/components/TerminalLayout.tsx`, add to `TerminalLayoutProps` (after `sendText`):

```ts
  /** Scroll the terminal scrollback by pages (negative = towards history). */
  onScrollPages: (pages: number) => void;
  /** Jump the terminal viewport to the newest output. */
  onScrollToBottom: () => void;
```

Destructure both props and pass them to `MobileTerminalLayout` (the desktop path deliberately never receives them):

```tsx
        <MobileTerminalLayout
          terminalElement={!isDesktop ? terminalElement : null}
          sessionId={sessionId}
          sessionName={sessionName}
          sendText={sendText}
          toolbarDisabled={toolbarDisabled}
          fileOps={fileOps}
          onTerminalReveal={onTerminalReveal}
          fontSizeManager={fontSizeManager}
          onGetTerminalPwd={onGetTerminalPwd}
          onScrollPages={onScrollPages}
          onScrollToBottom={onScrollToBottom}
        />
```

- [ ] **Step 5: Supply the callbacks from TerminalWorkspace**

In `web/src/terminal/components/TerminalWorkspace.tsx`, add to the `<TerminalLayout>` element (after `sendText`):

```tsx
          onScrollPages={(pages) => terminalHandle?.scrollPages(pages)}
          onScrollToBottom={() => terminalHandle?.scrollToBottom()}
```

(`terminalHandle` may be null on first render — optional chaining makes it a no-op, same pattern as `sendText`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/MobileTerminalLayout.test.tsx src/components/__tests__/TerminalScrollOverlay.test.tsx`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/MobileTerminalLayout.tsx web/src/components/TerminalLayout.tsx web/src/terminal/components/TerminalWorkspace.tsx web/src/components/__tests__/MobileTerminalLayout.test.tsx
git commit -m "feat: mount scroll overlay in mobile terminal layout"
```

---

### Task 4: Full quality gates

- [ ] **Step 1: Run the complete web gate set**

```bash
cd web
npx tsc --noEmit        # 0 errors
npm run lint            # 0 warnings (--max-warnings 0)
npm test                # 100% pass
npm run coverage        # ≥80% lines (new files must not drop it)
npm run build           # success
```

- [ ] **Step 2: Run Rust gates (unchanged code, but pre-commit runs them anyway)**

```bash
cargo fmt --all -- --check
cargo clippy -- -D warnings
cargo test
```

Expected: all clean.

- [ ] **Step 3: Commit (nothing to commit if gates only — skip unless fixes were made)**

```bash
git add -A && git commit -m "fix: address lint/coverage findings"
```

---

### Task 5: Playwright functional verification + screenshots

**Stack setup** (isolated HOME, three background processes from the worktree root):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &     # :19090 ws / :10080 http
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &   # needs tmux
cd web && npm run dev &                                   # :13000
```

- [ ] **Step 1: Mobile viewport — buttons visible and functional**

1. `browser_resize` to 375×812.
2. `browser_navigate` http://localhost:13000 → `browser_evaluate` `localStorage.clear()` → reload.
3. Log in (any non-empty token), create/attach a session.
4. Type `seq 1 500` + Enter in the terminal to generate scrollback.
5. `browser_snapshot` — verify the three scroll buttons exist (`Scroll up one page` / `Scroll down one page` / `Scroll to bottom`).
6. Record scroll position via `browser_evaluate`:
   `() => document.querySelector('.xterm-viewport')?.scrollTop`
7. Click "Scroll up one page" → re-evaluate `scrollTop` — must be smaller (scrolled towards history).
8. Click "Scroll to bottom" → `scrollTop` must equal the max (viewport back at newest output).
9. `browser_console_messages` — no errors.

- [ ] **Step 2: Desktop viewport — buttons hidden**

1. `browser_resize` to 1280×800.
2. `browser_snapshot` (or `browser_find` "Scroll up one page") — buttons must NOT be present.

- [ ] **Step 3: Capture screenshots (PR body)**

With `filename` prefixed `.playwright-mcp/screenshots/`:
- `mobile-scroll-overlay.png` — 375px, terminal with output + overlay visible.
- `mobile-scroll-history.png` — 375px, after page-up (historical output visible).
- `desktop-no-overlay.png` — 1280px, no overlay.

- [ ] **Step 4: Cleanup**

```bash
pkill -f 'target/debug/nession-(server|agent)'; pkill -f vite
```

---

### Task 6: PR

- [ ] **Step 1: Push and create PR**

```bash
git push -u origin feat/mobile-scroll-buttons
gh pr create \
  --title "feat: mobile scrollback toolbar buttons for terminal" \
  --body "$(cat <<'EOF'
## 变更内容
- TerminalView/TerminalHandle 暴露 scrollLines/scrollPages/scrollToBottom
- 新增 TerminalScrollOverlay：终端右下角悬浮 3 键（页↑ / 页↓ / 回到底部），仅移动端布局渲染
- 按钮 pointerdown preventDefault，点按不抢 MobileInput 焦点（键盘不收起）
- Closes #240

## 测试报告
- `cargo test`: <N> passed, 0 failed
- `cargo fmt --all -- --check`: OK
- `cargo clippy -- -D warnings`: 0 errors
- `npm test`: <N> passed
- `npm run coverage`: <X>% (threshold: 80%)
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 warnings
- `npm run build`: success

## 核心功能截图
![mobile scroll overlay](.playwright-mcp/screenshots/mobile-scroll-overlay.png)
![mobile scroll history](.playwright-mcp/screenshots/mobile-scroll-history.png)
![desktop no overlay](.playwright-mcp/screenshots/desktop-no-overlay.png)
EOF
)"
```

- [ ] **Step 2: Enable auto-merge**

```bash
gh pr merge --auto --squash   # run against the new PR number
```

- [ ] **Step 3: Version bump (after merge, separate chore branch from main)**

New user-facing feature → minor bump: `0.25.7` → `0.26.0` in BOTH `Cargo.toml` (workspace version) and `web/package.json`, via a `chore/bump-version` branch + PR (chore/** doesn't trigger CI; merge directly with `gh pr merge <N> --squash`).

---

## Self-Review

- **Spec coverage:** Goals 1 (buttons calling scrollLines/scrollPages/scrollToBottom — Task 1/2), 2 (mobile-only visibility — Task 3 mounts overlay only inside MobileTerminalLayout, hidden ≥1024px; verified in Task 5 Step 2) ✓. Scope (TerminalHandle/TerminalView methods — Task 1; terminal toolbar area — Task 2/3) ✓. Constraints (shadcn Button/Tooltip — Task 2; detectProfile-based mobile layout — Task 3; ESLint/tsc/vitest/coverage — Task 4) ✓. Success criteria 1–4 → Task 5 + Task 4 ✓. Edge cases → focus steal (pointerdown preventDefault, Task 2), boundary no-op (xterm clamps, noted in component docstring), empty scrollback (same), native touch scroll conflict (overlay is sibling of terminal element, not inside scrollContainer) ✓. Non-goals respected (no gesture work, no keyboard changes, no desktop changes) ✓.
- **Placeholders:** none — every step carries complete code or exact commands.
- **Type consistency:** `onScrollPages(pages: number)` / `onScrollToBottom()` names match across overlay, layouts, workspace; `scrollPages`/`scrollLines`/`scrollToBottom` match between `TerminalView`, `TerminalHandle`, and `Terminal.tsx` handle.

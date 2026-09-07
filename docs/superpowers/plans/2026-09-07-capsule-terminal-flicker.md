# App Capsule Resize Terminal Flicker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep xterm's viewport geometry stable while the App capsule changes height, eliminating resize/repaint flicker without removing the visual occlusion band.

**Architecture:** The capsule continues publishing occlusion through a CSS custom property. The terminal host consumes that value in its overlay band, while `TerminalViewport` no longer applies it as padding to the xterm mount element. Real terminal-well resizes continue through the existing `ResizeController`.

**Tech Stack:** React, TypeScript, xterm.js, Vitest, Testing Library, Vite.

---

### Task 1: Lock the viewport contract with a failing regression test

**Files:**
- Modify: `web/src/terminal/components/__tests__/integration/TerminalViewport.test.tsx`

- [ ] **Step 1: Change the test to require a stable viewport layout**

Replace the existing padding assertion with:

```tsx
  it('does not apply capsule occlusion as xterm layout padding', () => {
    const controller = makeController();
    const { container } = render(<TerminalViewport controller={controller} />);

    expect(container.firstElementChild).not.toHaveStyle({
      paddingBottom: 'var(--terminal-content-bottom-inset, 0px)',
    });
    expect(container.firstElementChild).toHaveAttribute('data-terminal-viewport');
  });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web && npm test -- src/terminal/components/__tests__/integration/TerminalViewport.test.tsx --run
```

Expected: the new test fails because `TerminalViewport` still renders the
dynamic `paddingBottom` style.

### Task 2: Remove the layout coupling and update documentation

**Files:**
- Modify: `web/src/terminal/components/TerminalViewport.tsx`
- Modify: `web/src/terminal/capsule/occlusionScroll.ts`

- [ ] **Step 1: Remove the dynamic padding from the viewport**

Keep the viewport classes and data attribute, but remove the `style` prop:

```tsx
    <div
      ref={containerRef}
      data-terminal-viewport
      className="h-full w-full box-border bg-terminal-background"
    />
```

- [ ] **Step 2: Align the occlusion scroll comment with the behavior**

Change the `scrollToMarginBottom` comment to state that xterm uses the full
well and the host overlay hides the occluded lines; do not change its runtime
behavior or the CSS variable writes.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
cd web && npm test -- src/terminal/components/__tests__/integration/TerminalViewport.test.tsx --run
```

Expected: all tests in the file pass.

### Task 3: Run regression and quality checks

**Files:** None.

- [ ] **Step 1: Run capsule and terminal tests**

```bash
cd web && npm test -- src/terminal/components/__tests__/integration/TerminalViewport.test.tsx src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts src/session-first/__tests__/integration/useCapsuleDockClearance.test.ts --run
```

- [ ] **Step 2: Run web typecheck, lint, and production build**

```bash
cd web && npx tsc --noEmit && npm run lint && npm run build
```

- [ ] **Step 3: Inspect the diff and commit**

```bash
git diff --check
git status --short
git add docs/superpowers/specs/2026-09-07-capsule-terminal-flicker-design.md docs/superpowers/plans/2026-09-07-capsule-terminal-flicker.md web/src/terminal/components/TerminalViewport.tsx web/src/terminal/components/__tests__/integration/TerminalViewport.test.tsx web/src/terminal/capsule/occlusionScroll.ts
git commit -m "fix(web): prevent terminal flicker on capsule resize"
```

### Task 4: Verify visually and deploy to staging

**Files:** None.

- [ ] **Step 1: Run the local UI stack and use Playwright**

Start the server, agent, and Vite app using an isolated HOME. In Playwright,
open the App terminal, capture the terminal before the capsule changes size,
enter enough multiline input to switch the capsule layout, and capture the
expanded state. Confirm the terminal remains painted and the controller is not
visibly remounted.

- [ ] **Step 2: Push and open the staging PR**

```bash
git push -u origin fix/capsule-terminal-flicker
gh pr create --base staging --title "fix(web): prevent terminal flicker on capsule resize" --body "## Summary
- Keep xterm viewport geometry stable while the App capsule changes height.
- Preserve the CSS occlusion band for live terminal scrollback.

## Test Plan
- Focused terminal/capsule Vitest tests
- TypeScript, ESLint, and production build
- Playwright staging-style local visual check"
```

- [ ] **Step 3: Enable auto-merge and watch staging deployment**

```bash
gh pr merge <PR_NUMBER> --auto --merge
./scripts/deploy-watch.sh staging
```

Expected: the quality gate passes, the PR is merge-committed to `staging`,
staging images are built, and the staging rollout completes successfully.

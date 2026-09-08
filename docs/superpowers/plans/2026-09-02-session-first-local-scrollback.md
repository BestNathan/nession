# Session-first Local Scrollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session-first scroll history come from xterm's browser buffer, let it pass under the floating capsule, and leave legacy scrolling/copy mode unchanged.

**Architecture:** Add an explicit `scrollbackMode` to terminal construction. In `local-buffer` mode, extend the capsule scroll controller to intercept vertical wheel input, drive xterm's local buffer, and toggle a `following/history` bottom inset on the capsule host. Legacy controllers do not install this behavior.

**Tech Stack:** React, TypeScript, xterm.js 5, Vitest, CSS custom properties.

---

### Task 1: Add an explicit session-first versus legacy scroll policy

**Files:**
- Modify: `web/src/terminal/types.ts`
- Modify: `web/src/terminal/hooks/useTerminal.ts`
- Modify: `web/src/session-first/terminal/useTerminalOrchestration.ts`
- Modify: `web/src/session-first/terminal/useSessionFirstTerminal.ts`
- Modify: `web/src/terminal/components/TerminalWorkspace.tsx`
- Test: `web/src/terminal/hooks/__tests__/integration/useTerminal.test.tsx`

- [ ] **Step 1: Write the failing policy propagation tests.**

  Assert that session-first's `useTerminal` call receives `scrollbackMode: 'local-buffer'`, while the legacy workspace receives `scrollbackMode: 'legacy'`.

- [ ] **Step 2: Run the focused tests and verify they fail because the option is absent.**

  Run `npm test -- src/terminal/hooks/__tests__/integration/useTerminal.test.tsx` from `web/`.

- [ ] **Step 3: Add the shared policy type and thread it through controller construction.**

  Add:

  ```ts
  export type TerminalScrollbackMode = 'local-buffer' | 'legacy';
  ```

  Add `scrollbackMode?: TerminalScrollbackMode` to `UseTerminalOptions`, default it to `'legacy'`, and pass it into `TerminalControllerOptions`. Session-first passes `'local-buffer'`; legacy passes `'legacy'` explicitly.

- [ ] **Step 4: Run the focused tests and verify they pass.**

  Run `npm test -- src/terminal/hooks/__tests__/integration/useTerminal.test.tsx` from `web/`.

### Task 2: Add the local browser-buffer scroll state machine

**Files:**
- Modify: `web/src/terminal/capsule/occlusionScroll.ts`
- Test: `web/src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts`

- [ ] **Step 1: Write failing unit tests for mode transitions.**

  Cover these behaviors:

  ```ts
  expect(controller.mode()).toBe('following');
  controller.enterHistory();
  expect(controller.mode()).toBe('history');
  expect(host.style.getPropertyValue('--terminal-content-bottom-inset')).toBe('0px');
  controller.followBottom();
  expect(host.style.getPropertyValue('--terminal-content-bottom-inset'))
    .toBe('var(--terminal-capsule-occlusion, 0px)');
  ```

  Also cover that output in history does not call `scrollToBottom`, while output in following does.

- [ ] **Step 2: Run the unit test and verify the new assertions fail.**

  Run `npm test -- src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts` from `web/`.

- [ ] **Step 3: Implement the smallest state-machine API.**

  Add `ScrollMode = 'following' | 'history'`, store it in `CapsuleOcclusionScroll`, and centralize host CSS synchronization:

  ```ts
  private syncLayoutMode(): void {
    const inset = this.mode === 'following'
      ? 'var(--terminal-capsule-occlusion, 0px)'
      : '0px';
    this.host.style.setProperty('--terminal-content-bottom-inset', inset);
    this.host.dataset.terminalScrollMode = this.mode;
  }
  ```

  User/API scrolling away from the real bottom enters history. Reaching the real bottom enters following. Guard controller-driven scrolls so `scrollToBottom()` cannot immediately be reclassified as history.

- [ ] **Step 4: Run the unit test and verify it passes.**

  Run `npm test -- src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts` from `web/`.

### Task 3: Intercept session-first vertical scrolling before tmux mouse reporting

**Files:**
- Modify: `web/src/terminal/capsule/occlusionScroll.ts`
- Modify: `web/src/terminal/controller/TerminalController.ts`
- Test: `web/src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts`
- Test: `web/src/terminal/controller/__tests__/integration/TerminalController.test.ts`

- [ ] **Step 1: Write failing tests for local wheel handling and legacy isolation.**

  Dispatch a vertical wheel event against a local-buffer terminal and assert that `preventDefault`/propagation prevention occurs and xterm's local scroll API is called. Construct a legacy controller with a capsule host and assert no local wheel listener/controller is installed.

- [ ] **Step 2: Run those tests and verify they fail.**

  Run `npm test -- src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts src/terminal/controller/__tests__/integration/TerminalController.test.ts` from `web/`.

- [ ] **Step 3: Install the capture listener only for `local-buffer`.**

  In `CapsuleOcclusionScroll.bind()`, attach a capture-phase `wheel` listener to `terminal.element`. Normalize `deltaMode` to lines, call `terminal.scrollLines(lines)`, call `preventDefault()` and `stopPropagation()`, and update the following/history state. Remove the listener in `dispose()`.

  In `TerminalController.wireTerminalUi()`, create `CapsuleOcclusionScroll` only when `scrollbackMode === 'local-buffer'`. The legacy path must not receive this listener or dynamic inset state.

- [ ] **Step 4: Run the focused tests and verify they pass.**

  Run the same two test files. Confirm no legacy test observes a changed event path.

### Task 4: Connect dynamic inset to the terminal and capsule visuals

**Files:**
- Modify: `web/src/terminal/components/TerminalViewport.tsx`
- Modify: `web/src/index.css`
- Test: `web/src/terminal/components/__tests__/integration/TerminalViewport.test.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionFirstTerminal.test.tsx`

- [ ] **Step 1: Write failing visual-state assertions.**

  Assert that TerminalViewport consumes `--terminal-content-bottom-inset`, and that the session-first host declares the local-buffer behavior marker without requiring the legacy layout to do so.

- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run `npm test -- src/terminal/components/__tests__/integration/TerminalViewport.test.tsx src/session-first/__tests__/integration/SessionFirstTerminal.test.tsx` from `web/`.

- [ ] **Step 3: Switch the viewport and fake occlusion band to the dynamic variable.**

  Change TerminalViewport to:

  ```tsx
  style={{ paddingBottom: 'var(--terminal-content-bottom-inset, 0px)' }}
  ```

  Make the host's default inset follow the capsule occlusion, and make the `::after` height use the dynamic inset so it disappears in history mode. Keep the capsule's absolute positioning and z-index unchanged.

- [ ] **Step 4: Run the focused tests and verify they pass.**

  Run the two focused test files again.

### Task 5: Preserve output, resize, buttons, and reattach semantics

**Files:**
- Modify: `web/src/terminal/capsule/occlusionScroll.ts`
- Modify: `web/src/terminal/controller/TerminalController.ts`
- Modify: `web/src/components/TerminalScrollOverlay.tsx` only if the local mode needs an explicit history transition
- Test: `web/src/terminal/capsule/__tests__/unit/occlusionScroll.test.ts`
- Test: `web/src/terminal/controller/__tests__/integration/TerminalController.test.ts`

- [ ] **Step 1: Add failing tests for output, resize, and return-to-bottom ordering.**

  Verify that output while history leaves `viewportY` unchanged, output while following schedules bottom alignment, capsule geometry changes do not move history, and `scrollToBottom()` restores the inset before aligning xterm.

- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run the relevant capsule and controller tests from `web/`.

- [ ] **Step 3: Implement guarded scheduling and cleanup.**

  Preserve the existing double-RAF alignment for following mode, add cancellation during dispose, and ensure rebind derives state from xterm's current real viewport rather than stale DOM attributes. Keep `scrollToBottom()` as the only automatic bottom action; never use `scrollLines(-margin)` for capsule clearance.

- [ ] **Step 4: Run the focused tests and verify they pass.**

  Run the relevant capsule, controller, viewport, and session-first tests.

### Task 6: Full verification without committing

**Files:**
- No additional production files unless a test exposes a scoped regression.

- [ ] **Step 1: Run the full test suite.**

  Run `npm test` from `web/`; expected result is all tests passing.

- [ ] **Step 2: Run build and static checks.**

  Run `npm run build` and `npm run lint` from `web/`, then `git diff --check` from the worktree root.

- [ ] **Step 3: Inspect the final diff and status.**

  Confirm only the intended implementation/test/plan files changed in this session, no commit was created, and report the exact commands and results for local acceptance.

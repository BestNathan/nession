# Terminal Capsule Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace session-first TerminalCapsule sheet UX with a single-row dock, popover-based History/Commands, history ghost+Tab completion, and mobile icon mode toggle.

**Architecture:** New `web/src/session-first/capsule/` module owns all capsule UI. Extract send/chain logic from `QuickCommandsPanel` into `useCapsuleCommands`. Desktop: input bar + History/Commands popovers (no phys keys). Mobile: icon toggle; Commands row = quick keys + `⋯` popover with full keys and command list.

**Tech Stack:** React, Tailwind v4, shadcn Popover/ToggleGroup/Button, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-terminal-capsule-redesign-design.md`

**Worktree base:** `origin/staging`. Branch: `feat/terminal-capsule-redesign`. PR → `staging`.

---

## File map

| File | Role |
|------|------|
| `web/src/session-first/capsule/types.ts` | `CapsuleMode`, shared prop types |
| `web/src/session-first/capsule/useCapsuleCommands.ts` | send, chain, presets, user cmds |
| `web/src/session-first/capsule/useHistoryGhost.ts` | prefix match suffix for ghost |
| `web/src/session-first/capsule/CapsuleGhostInput.tsx` | input + ghost overlay + Tab |
| `web/src/session-first/capsule/CapsuleInputRow.tsx` | input row + action buttons |
| `web/src/session-first/capsule/CapsuleHistoryPopover.tsx` | history list popover |
| `web/src/session-first/capsule/CapsuleCommandsPopover.tsx` | commands + optional KeyRow |
| `web/src/session-first/capsule/CapsuleCommandsRow.tsx` | mobile quick phys keys row |
| `web/src/session-first/capsule/CapsuleModeToggle.tsx` | mobile icon toggle |
| `web/src/session-first/capsule/CapsuleChainBar.tsx` | chain banner (extract from QuickCommandsPanel pattern) |
| `web/src/session-first/capsule/TerminalCapsule.tsx` | shell: desktop vs mobile layout |
| `web/src/session-first/TerminalCapsule.tsx` | re-export from `./capsule/TerminalCapsule` for stable imports |
| `web/src/components/TerminalLayout.tsx` | remove expanded state; new capsule props |
| `web/src/components/MobileTerminalLayout.tsx` | mode state; new capsule |

**Do not touch:** `InputPanel.tsx`, `QuickCommandsPanel.tsx`, BottomBar legacy path.

---

### Task 1: `useCapsuleCommands` hook (TDD)

**Files:**
- Create: `web/src/session-first/capsule/useCapsuleCommands.ts`
- Create: `web/src/session-first/capsule/__tests__/unit/useCapsuleCommands.test.ts`

- [ ] **Step 1:** Write tests for: `handleRun` (appends `\r` unless raw), chain start/add/send/cancel, `allCommands` merges PRESETS + user.
- [ ] **Step 2:** Run tests — expect FAIL (module missing).
- [ ] **Step 3:** Implement hook by extracting logic from `QuickCommandsPanel` (lines ~413–446 pattern) without UI imports.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit: `feat(web): extract useCapsuleCommands hook for capsule redesign`

---

### Task 2: `useHistoryGhost` hook (TDD)

**Files:**
- Create: `web/src/session-first/capsule/useHistoryGhost.ts`
- Create: `web/src/session-first/capsule/__tests__/unit/useHistoryGhost.test.ts`

- [ ] **Step 1:** Test cases:
  - empty input → no ghost
  - input `aaa`, history has `aaa --verbose` → ghost suffix ` --verbose`
  - no prefix match → no ghost
  - `acceptGhost()` appends suffix
- [ ] **Step 2:** Red run.
- [ ] **Step 3:** Implement using `useCommandHistory().filterHistory` or direct entries scan (most recent wins).
- [ ] **Step 4:** Green run.
- [ ] **Step 5:** Commit: `feat(web): add useHistoryGhost for capsule Tab completion`

---

### Task 3: `CapsuleGhostInput` component (TDD)

**Files:**
- Create: `web/src/session-first/capsule/CapsuleGhostInput.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleGhostInput.test.tsx`

- [ ] **Step 1:** Test: renders input; shows ghost suffix element when hook returns suffix; Tab calls accept; composing suppresses ghost (mock `isComposing` on key event).
- [ ] **Step 2:** Red.
- [ ] **Step 3:** Implement overlay or stacked span approach — ghost must not be submitted in `value`.
- [ ] **Step 4:** Green + `npm run lint` on touched files.
- [ ] **Step 5:** Commit: `feat(web): CapsuleGhostInput with Tab completion`

---

### Task 4: `CapsuleHistoryPopover` (TDD)

**Files:**
- Create: `web/src/session-first/capsule/CapsuleHistoryPopover.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleHistoryPopover.test.tsx`

- [ ] **Step 1:** Test: trigger opens popover; lists filtered entries; click row calls `onSelect(command)` and closes.
- [ ] **Step 2–4:** TDD cycle.
- [ ] **Step 5:** Commit: `feat(web): CapsuleHistoryPopover for capsule input`

---

### Task 5: `CapsuleCommandsPopover` (TDD)

**Files:**
- Create: `web/src/session-first/capsule/CapsuleChainBar.tsx` (small presentational)
- Create: `web/src/session-first/capsule/CapsuleCommandsPopover.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`

- [ ] **Step 1:** Tests:
  - `showPhysKeys={false}` → no KeyRow test ids
  - `showPhysKeys={true}` → KeyRow visible
  - clicking preset calls sendText
  - Add command opens dialog (mock dialog or test add handler)
- [ ] **Step 2–4:** Implement; reuse KeyRow by **moving** KeyRow + phys key constants to `capsule/PhysKeyRow.tsx` copied from QuickCommandsPanel (duplicate minimal UI, do not import QuickCommandsPanel).
- [ ] **Step 5:** Commit: `feat(web): CapsuleCommandsPopover with optional phys keys`

---

### Task 6: `CapsuleInputRow` + multi-line growth (TDD)

**Files:**
- Create: `web/src/session-first/capsule/CapsuleInputRow.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleInputRow.test.tsx`

- [ ] **Step 1:** Tests: Send disabled when empty; Send calls sendText with `\r`; History button toggles popover; measures `rows`/class when content includes newline → expanded class on parent callback `onHeightChange('multi')`.
- [ ] **Step 2–4:** Implement row with CapsuleGhostInput, action buttons, CapsuleHistoryPopover; use textarea with `rows={1}` and auto-grow detection (scrollHeight or newline count).
- [ ] **Step 5:** Commit: `feat(web): CapsuleInputRow with send and history popover`

---

### Task 7: Mobile `CapsuleCommandsRow` + `CapsuleModeToggle` (TDD)

**Files:**
- Create: `web/src/session-first/capsule/CapsuleCommandsRow.tsx`
- Create: `web/src/session-first/capsule/CapsuleModeToggle.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleModeToggle.test.tsx`

- [ ] **Step 1:** Tests:
  - ModeToggle fires `onModeChange('commands'|'input')`
  - CommandsRow renders quick keys (Esc, Tab, …); tap calls sendText
  - `⋯` opens CapsuleCommandsPopover with showPhysKeys true
- [ ] **Step 2–4:** TDD.
- [ ] **Step 5:** Commit: `feat(web): mobile capsule commands row and mode toggle`

---

### Task 8: `TerminalCapsule` shell rewrite (TDD)

**Files:**
- Create: `web/src/session-first/capsule/TerminalCapsule.tsx`
- Create: `web/src/session-first/capsule/types.ts`
- Modify: `web/src/session-first/TerminalCapsule.tsx` → re-export
- Rewrite: `web/src/session-first/__tests__/integration/TerminalCapsule.test.tsx`

- [ ] **Step 1:** Tests:
  - No `terminal-capsule-sheet` in document ever
  - Desktop render (no mode toggle): Input row + Commands popover trigger present
  - Mobile render (`mode` prop set): mode toggle + switches body
  - `disabled` sets data-disabled
  - Popovers mutually exclusive (open History closes Commands)
- [ ] **Step 2–4:** Implement shell with `useMediaQuery('(min-width: 768px)')` or pass `variant` from parent — prefer parent passes `variant: 'desktop' | 'mobile'` to keep capsule testable.
- [ ] **Step 5:** Commit: `feat(web): rewrite TerminalCapsule shell without legacy sheet`

---

### Task 9: Wire layouts — remove expanded state (TDD)

**Files:**
- Modify: `web/src/components/TerminalLayout.tsx`
- Modify: `web/src/components/MobileTerminalLayout.tsx`
- Modify: `web/src/components/__tests__/integration/TerminalLayout.capsule.test.tsx`
- Modify: `web/src/components/__tests__/integration/MobileTerminalLayout.test.tsx`

- [ ] **Step 1:** Update tests — remove expectations for `terminal-capsule-expand`, sheet, text mode buttons `terminal-capsule-mode-input`.
- [ ] **Step 2:** Remove `capsuleExpanded` / `onCapsuleExpandedChange` state; stop passing `inputPanel`/`commandsPanel` to capsule; pass `sendText`, `disabled`, and on mobile `mode`/`onModeChange`.
- [ ] **Step 3:** Run `npx vitest run` on affected integration tests + `npm run lint`.
- [ ] **Step 4:** Commit: `feat(web): wire capsule redesign in TerminalLayout surfaces`

---

### Task 10: Playwright + full verification

- [ ] **Step 1:** Local stack with `?session_first=1`.
- [ ] **Step 2:** Screenshots to `.playwright-mcp/screenshots/`:
  - desktop-input-ghost.png
  - desktop-commands-popover.png
  - mobile-input-row.png
  - mobile-commands-row-popover.png
- [ ] **Step 3:** `cd web && npm run lint && npx vitest run src/session-first/capsule src/session-first/__tests__/integration/TerminalCapsule.test.tsx`
- [ ] **Step 4:** PR to staging with 变更内容 + 测试报告; screenshots in PR comment.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| No legacy sheet | Task 8 tests |
| Desktop no Commands mode | Task 8 desktop variant |
| Desktop no phys keys | Task 5 `showPhysKeys=false` |
| Mobile icon toggle | Task 7 |
| Mobile single-row commands + popover | Task 7 |
| Ghost + Tab | Tasks 2–3 |
| History popover | Task 4 |
| Multi-line input growth | Task 6 |
| Legacy BottomBar untouched | Explicit non-touch |

---

## Execution handoff

```bash
git fetch origin
git worktree add -b feat/terminal-capsule-redesign \
  .claude/worktrees/feat-terminal-capsule-redesign origin/staging
```

Execute Tasks 1 → 10 in order.

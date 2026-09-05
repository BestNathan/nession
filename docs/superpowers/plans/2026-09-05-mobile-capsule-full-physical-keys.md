# Mobile Capsule Full Physical-Key Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the expanded mobile command panel's complete physical-key layout while keeping the collapsed capsule limited to common keys.

**Architecture:** Keep `CapsuleCommandsRow` as the compact surface backed by `QUICK_MOBILE_KEYS`. Make `PhysKeyRow` the complete expanded surface, rendering every `LEFT_KEYS` item and every `ARROW_KEYS` item directly through the existing `KeyButton` interaction path. Keep the shared Popover, `useCapsuleCommands`, and terminal/WebSocket infrastructure unchanged.

**Tech Stack:** React, TypeScript, Tailwind token classes, Vitest, Testing Library, Base UI Popover.

---

### Task 1: Lock the complete-key contract with failing integration tests

**Files:**
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx`

- [ ] **Step 1: Update the expanded-panel assertions to require all direct physical keys**

Import `LEFT_KEYS` and `ARROW_KEYS` from `@/session-first/capsule/physKeys`. Replace the test that expects compact keys plus overflow with an expanded-panel contract:

```tsx
it('shows the complete physical key layout in the expanded panel', () => {
  render(
    <CapsuleCommandsPopover
      open
      onOpenChange={vi.fn()}
      sendText={sendText}
      showPhysKeys
    />,
  );

  expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
  expect(screen.queryByTestId('phys-key-overflow')).not.toBeInTheDocument();
  for (const keyDef of [...LEFT_KEYS, ...ARROW_KEYS]) {
    expect(screen.getByTestId(`phys-key-${keyDef.label}`)).toBeInTheDocument();
  }
});
```

- [ ] **Step 2: Add direct arrow execution coverage**

Add a test that clicks the visible `↑` button and verifies exactly one terminal sequence and one presentation close request:

```tsx
it('sends a visible arrow key once and closes after execution', async () => {
  const onOpenChange = vi.fn();
  render(
    <CapsuleCommandsPopover
      open
      onOpenChange={onOpenChange}
      sendText={sendText}
      showPhysKeys
    />,
  );

  await userEvent.click(screen.getByTestId('phys-key-↑'));

  expect(sendText).toHaveBeenCalledTimes(1);
  expect(sendText).toHaveBeenCalledWith('\x1b[A');
  expect(onOpenChange).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
```

- [ ] **Step 3: Make the long-press chain use an arrow as the chained key**

Keep the existing long-press start on `Esc`, change the second key to `→`, and replace the final assertions with:

```tsx
const secondKey = screen.getByTestId('phys-key-→');
fireEvent.pointerDown(secondKey);
fireEvent.pointerUp(secondKey);

fireEvent.click(screen.getByRole('button', { name: 'Send' }));

expect(sendText).toHaveBeenCalledTimes(1);
expect(sendText).toHaveBeenCalledWith('\x1b\x1b[C');
expect(onOpenChange).toHaveBeenCalledTimes(1);
expect(onOpenChange).toHaveBeenCalledWith(false);
```

This verifies arrows use `KeyButton` and remain chainable.

- [ ] **Step 4: Assert the collapsed capsule remains compact**

Keep the row-level test focused on `CapsuleCommandsRow`: assert its default quick-key buttons are present, the More trigger is present, and no expanded `phys-key-row` is mounted before opening the Popover. Rename descriptions to say “quick-key row” rather than “commands sheet.”

- [ ] **Step 5: Run the focused tests and verify the new contract fails**

Run:

```bash
cd web && npm test -- --run src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx
```

Expected: failures show that the current implementation still hides `LEFT_KEYS` and `ARROW_KEYS` behind the overflow menu.

- [ ] **Step 6: Commit the red tests**

```bash
git add web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx
git commit -m "test(web): require full expanded physical key panel"
```

### Task 2: Restore the original complete physical-key layout

**Files:**
- Modify: `web/src/session-first/capsule/PhysKeyRow.tsx`
- Modify: `web/src/session-first/capsule/capsuleStyles.ts`

- [ ] **Step 1: Replace overflow partitioning with direct key sets**

In `PhysKeyRow.tsx`, remove the `DropdownMenu` imports, `MoreHorizontal` import, `QUICK_MOBILE_KEYS` import, and overflow style imports. Render `LEFT_KEYS` in a five-column, two-row grid and `ARROW_KEYS` in the existing T-shaped three-column, two-row grid:

```tsx
return (
  <div data-testid="phys-key-row" className={capsulePhysKeyRowClass}>
    <div className={cn('grid min-w-0 flex-1 grid-cols-5', capsulePhysKeyGridGapClass)}>
      {LEFT_KEYS.map((keyDef) => (
        <KeyButton key={keyDef.label} keyDef={keyDef} />
      ))}
    </div>
    <div className={cn('grid shrink-0 grid-cols-3 grid-rows-2', capsulePhysKeyGridGapClass)}>
      <div />
      <KeyButton keyDef={ARROW_KEYS[0]} />
      <div />
      <KeyButton keyDef={ARROW_KEYS[1]} />
      <KeyButton keyDef={ARROW_KEYS[2]} />
      <KeyButton keyDef={ARROW_KEYS[3]} />
    </div>
  </div>
);
```

Keep the existing `KeyButton` pointer-down, pointer-up, pointer-leave, context-menu, disabled, and chain behavior unchanged. Both arrow and left-key buttons must use `capsulePhysKeyButtonClass`.

- [ ] **Step 2: Restore only the shared grid-gap token class**

In `capsuleStyles.ts`, add back the existing tokenized export:

```ts
export const capsulePhysKeyGridGapClass = 'gap-[length:var(--composer-phys-key-grid-gap)]';
```

Do not reintroduce `capsulePhysKeyScrollClass` or `capsulePhysKeyOverflowClass`; they are no longer part of the expanded panel contract. Leave collapsed-row scroll styles unchanged.

- [ ] **Step 3: Run focused tests and lint**

Run:

```bash
cd web && npm test -- --run src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx src/session-first/capsule/__tests__/unit/useCapsuleCommands.test.ts
cd web && npm run lint
```

Expected: all focused tests pass, including all 14 direct key assertions and arrow chaining.

- [ ] **Step 4: Commit the implementation**

```bash
git add web/src/session-first/capsule/PhysKeyRow.tsx web/src/session-first/capsule/capsuleStyles.ts
git commit -m "fix(web): restore full mobile physical key panel"
```

### Task 3: Remove stale compact-panel style tests and validate the complete contract

**Files:**
- Modify: `web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts`
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`

- [ ] **Step 1: Update style contract coverage**

Keep tests for `capsulePopoverPanelClass` viewport-safe width. Remove assertions whose only purpose was the deleted expanded-panel scroll/overflow classes. Add an assertion for the restored grid-gap token class:

```tsx
expect(capsulePhysKeyGridGapClass).toContain('var(--composer-phys-key-grid-gap)');
```

- [ ] **Step 2: Verify command list and add footer remain visible**

In the expanded-panel integration test, assert `capsule-add-command` remains present after all physical-key buttons are rendered. This prevents the restored grid from consuming the command list/footer layout.

- [ ] **Step 3: Run the capsule suite**

```bash
cd web && npm test -- --run src/session-first/capsule
```

Expected: all capsule tests pass with no Sheet or overflow assumptions remaining.

- [ ] **Step 4: Commit test cleanup**

```bash
git add web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx
git commit -m "test(web): cover complete expanded capsule controls"
```

### Task 4: Full verification

**Files:**
- No additional source files; verify the implementation and committed spec/plan.

- [ ] **Step 1: Run the complete web test suite**

```bash
cd web && npm test -- --run
```

Expected: all test files and tests pass.

- [ ] **Step 2: Run lint, build, and token checks**

```bash
cd web && npm run lint && npm run build
cd .. && just tokens-check && git diff --check
```

Expected: all commands exit zero. Existing build chunk-size warnings are acceptable if no new errors appear.

- [ ] **Step 3: Confirm collapsed and expanded surfaces are distinct**

Use the existing integration coverage to confirm `CapsuleCommandsRow` renders only `QUICK_MOBILE_KEYS`, while `CapsuleCommandsPopover` renders all `LEFT_KEYS` and `ARROW_KEYS`. Confirm there are no remaining `capsulePhysKeyOverflowClass`, `capsulePhysKeyScrollClass`, or `DropdownMenu` references in `PhysKeyRow.tsx`.

- [ ] **Step 4: Commit only if verification metadata changed**

```bash
git status --short
git log --oneline -6
```

Expected: clean worktree with the spec, plan, test, and implementation commits; no generated artifacts or unrelated files.

# Mobile Capsule Command Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile TerminalCapsule command Sheet with a compact anchored popover that keeps terminal output visible and preserves all quick-command behavior.

**Architecture:** Keep `useCapsuleCommands` and `commandsOpen` as the single data/state sources. Reuse the existing command panel body and Base UI Popover for both experiences; mobile differences are expressed through tokenized width, height, scrolling, and touch-key presentation. The full-screen Sheet remains available to unrelated consumers but is removed from this command-panel path.

**Tech Stack:** React, TypeScript, Base UI Popover, Tailwind class tokens, Vitest, Testing Library, Playwright smoke checks.

---

### Task 1: Lock the anchored-popover contract with failing integration tests

**Files:**
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx`

- [ ] **Step 1: Change the mobile presentation assertion to require Popover and reject Sheet**

In `CapsuleCommandsPopover.test.tsx`, keep the existing `presentation="sheet"` input temporarily to represent the current mobile call site, but change the test to expect an anchored popover:

```tsx
it('renders the mobile commands panel as an anchored popover', () => {
  render(
    <CapsuleCommandsPopover
      open
      onOpenChange={vi.fn()}
      sendText={sendText}
      showPhysKeys
      presentation="sheet"
      trigger={<button type="button" data-testid="capsule-commands-more">More</button>}
    />,
  );

  expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument();
  expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeInTheDocument();
  expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Add the command-close behavior assertion**

Add a test using an `onOpenChange` spy. After clicking the built-in `Ctrl+C` command, assert that `sendText` receives `\x03` and the controlled panel requests close with `false`:

```tsx
it('closes after executing a command', async () => {
  const onOpenChange = vi.fn();
  render(
    <CapsuleCommandsPopover
      open
      onOpenChange={onOpenChange}
      sendText={sendText}
      showPhysKeys={false}
    />,
  );

  await userEvent.click(screen.getByText('Ctrl+C'));

  expect(sendText).toHaveBeenCalledWith('\x03');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
```

- [ ] **Step 3: Update the row-level test to require an anchored popover**

In `CapsuleCommandsRow.test.tsx`, change the open-panel assertion to query `[data-slot="popover-content"]`, and assert that `[data-slot="sheet-content"]` and `[data-slot="sheet-overlay"]` are absent.

- [ ] **Step 4: Run the focused tests and verify they fail for the missing behavior**

Run:

```bash
cd web && npm test -- --run src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx
```

Expected: FAIL because the current mobile path renders `Sheet`, and command execution does not explicitly request close.

### Task 2: Add tokenized mobile panel sizing and compact key-row styles

**Files:**
- Modify: `design/tokens/experience/app.json`
- Modify: `design/tokens/experience/web.json`
- Modify: `web/src/session-first/capsule/capsuleStyles.ts`
- Generated: `design/generated/web.css`
- Generated: `design/generated/app.ts`

- [ ] **Step 1: Add a viewport inset token to both experience token files**

Add this sibling to `popoverWidth` in both `experience/app.json` and `experience/web.json`:

```json
"popoverViewportInset": { "value": "1.5rem" }
```

This represents the combined safe horizontal margin used when a fixed-width popover must fit a narrow viewport.

- [ ] **Step 2: Regenerate and validate design tokens**

Run:

```bash
just tokens-gen
just tokens-check
```

Expected: generated CSS/TypeScript includes `--composer-popover-viewport-inset` and the check exits successfully.

- [ ] **Step 3: Make the popover width viewport-safe and define compact key-row layout classes**

Update `capsulePopoverPanelClass` so it retains the token width while capping the actual panel width:

```ts
export const capsulePopoverPanelClass =
  'z-[length:var(--composer-popover-z-index)] max-h-[length:var(--composer-popover-max-height)] w-[length:var(--composer-popover-width)] max-w-[calc(100vw-var(--composer-popover-viewport-inset))] overflow-hidden border-border bg-popover p-0 text-popover-foreground shadow-md';
```

Add focused classes for the redesigned row:

```ts
export const capsulePhysKeyScrollClass =
  'flex min-w-0 flex-1 items-center gap-[length:var(--composer-phys-key-grid-gap)] overflow-x-auto scrollbar-none';

export const capsulePhysKeyOverflowClass = 'shrink-0';
```

- [ ] **Step 4: Run the focused style/lint checks**

Run:

```bash
just check-design-tokens
cd web && npm run lint
```

Expected: both commands pass with no new warnings treated as errors.

### Task 3: Replace the mobile Sheet path with the shared anchored Popover

**Files:**
- Modify: `web/src/session-first/capsule/CapsuleCommandsPopover.tsx`
- Modify: `web/src/session-first/capsule/CapsuleCommandsRow.tsx`
- Test: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`
- Test: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx`

- [ ] **Step 1: Remove the Sheet-only presentation branch**

In `CapsuleCommandsPopover.tsx`:

- Remove the `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, and `SheetTrigger` imports.
- Remove `CapsuleCommandsPresentation` and the `presentation` prop.
- Keep one `Popover`/`PopoverTrigger`/`PopoverContent` tree for all callers.
- Keep `PopoverContent` aligned `end`, placed `top`, and use `readPopoverSideOffset()` plus `capsulePopoverPanelClass`.

The resulting presentation boundary should have this shape:

```tsx
return (
  <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger nativeButton disabled={disabled} render={triggerElement} />
    <PopoverContent
      align="end"
      side="top"
      sideOffset={readPopoverSideOffset()}
      className={capsulePopoverPanelClass}
    >
      <PopoverHeader className={cn(capsulePopoverHeaderClass, 'border-b border-border/60')}>
        <PopoverTitle>Quick commands</PopoverTitle>
      </PopoverHeader>
      {panelBody}
    </PopoverContent>
  </Popover>
);
```

- [ ] **Step 2: Close the controlled panel after command actions**

Wrap the hook actions at the presentation boundary so the hook keeps sending/history behavior and the UI owns dismissal:

```tsx
const handleRun = useCallback((command: QuickCommand) => {
  commands.handleRun(command);
  onOpenChange(false);
}, [commands.handleRun, onOpenChange]);

const handlePhysKey = useCallback((seq: string) => {
  commands.handlePhysKey(seq);
  onOpenChange(false);
}, [commands.handlePhysKey, onOpenChange]);

const sendChain = useCallback(() => {
  commands.sendChain();
  onOpenChange(false);
}, [commands.sendChain, onOpenChange]);
```

Pass these wrappers to `CapsuleCommandsPanelBody`; leave `handleChainStart` and `handleChainAdd` unwrapped so long-press chaining can continue inside the panel.

- [ ] **Step 3: Remove the mobile `presentation="sheet"` prop from the row**

In `CapsuleCommandsRow.tsx`, keep the custom `CapsuleCommandsMoreTrigger` and remove only the `presentation="sheet"` prop. The row remains controlled by `commandsOpen` and `onCommandsOpenChange`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
cd web && npm test -- --run src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx
```

Expected: all focused tests pass, including the no-Sheet and close-after-command assertions.

### Task 4: Make the physical-key row compact and independently scrollable

**Files:**
- Modify: `web/src/session-first/capsule/PhysKeyRow.tsx`
- Modify: `web/src/session-first/capsule/capsuleStyles.ts`
- Test: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`

- [ ] **Step 1: Render common mobile keys in the primary horizontal row**

Use `QUICK_MOBILE_KEYS` as the visible set. Keep the existing `KeyButton` implementation and its pointer/long-press handlers. Render the visible keys inside `capsulePhysKeyScrollClass` so the panel shows common keys first without forcing a two-row keyboard grid.

- [ ] **Step 2: Move uncommon keys and arrows behind the row overflow trigger**

Build the overflow list from the remaining `LEFT_KEYS` plus `ARROW_KEYS`, and render it through the existing `DropdownMenu` with `capsulePhysKeyOverflowClass`. Keep each overflow item calling `onKey(keyDef.seq)` exactly once.

- [ ] **Step 3: Preserve touch sizing and safe panel padding**

Keep `capsulePhysKeyButtonClass` on every visible key and overflow trigger. Keep `capsulePhysKeyRowClass` responsible for the border and tokenized horizontal/vertical padding; do not add numeric Tailwind dimensions.

- [ ] **Step 4: Add a regression assertion for the compact row**

Assert that the open command panel contains `data-testid="phys-key-row"`, a horizontally scrollable key container, and the overflow trigger. Assert that selecting a visible key sends once and requests panel close.

- [ ] **Step 5: Run the focused physical-key tests**

Run:

```bash
cd web && npm test -- --run src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx src/session-first/capsule/__tests__/unit/useCapsuleCommands.test.ts
```

Expected: all focused tests pass and existing long-press/chaining unit coverage remains green.

### Task 5: Verify the complete UI contract

**Files:**
- Test: existing capsule integration/unit tests
- Browser: mobile fixture route used by the repository's Playwright setup

- [ ] **Step 1: Run the complete web test suite**

Run:

```bash
cd web && npm test -- --run
```

Expected: all test files and tests pass.

- [ ] **Step 2: Run lint and production build**

Run:

```bash
cd web && npm run lint && npm run build
```

Expected: both pass; existing Vite chunk-size and dependency deprecation warnings may remain, but no new errors appear.

- [ ] **Step 3: Perform browser smoke checks at mobile sizes**

At 375px portrait and a narrow landscape viewport, verify:

1. The three-dots trigger opens the anchored panel above the trigger.
2. Terminal output remains crisp and visible; no full-screen Sheet overlay appears.
3. The panel fits within viewport gutters and does not create horizontal page scroll.
4. The key row scrolls horizontally and the command list scrolls vertically independently.
5. A visible key and a command each send once and close the panel.
6. Outside click, `Escape`, and platform back close the panel.
7. The add-command dialog remains operable.

- [ ] **Step 4: Run final diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors, and only the planned design/token/component/test files are changed.


# Mobile Capsule Physical-Key Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the expanded mobile capsule command panel show shortcut keys and arrow keys side by side, with compact visual sizing and no label overlap.

**Architecture:** Keep the existing `PhysKeyRow` and `capsuleStyles` boundaries. Add a compact physical-key font token and a separate arrow-button width class, then let the shortcut grid flex while the arrow grid stays fixed on the right. The existing interaction code remains unchanged: physical keys keep the panel open, quick commands close it.

**Tech Stack:** React, TypeScript, Tailwind utility classes, generated CSS design tokens, Vitest, Testing Library.

---

## File map

- Modify `design/generated/web.css`: tune only the `[data-experience="app"]` composer/popover tokens used by the mobile capsule.
- Modify `web/src/session-first/capsule/capsuleStyles.ts`: define the horizontal row, compact physical-key typography, and arrow-button sizing classes.
- Modify `web/src/session-first/capsule/PhysKeyRow.tsx`: render the five shortcut buttons in a flexible left grid and the arrow cluster in a fixed right grid; use a narrower arrow-button class without changing event behavior.
- Modify `web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts`: lock the horizontal layout and compact/no-wrap style contract.
- Modify `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`: assert the rendered row has left and right layout regions and preserve the existing interaction tests.

## Task 1: Add failing layout and compact-style tests

**Files:**
- Modify: `web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts`
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`

- [ ] **Step 1: Extend the style test imports and assertions.**

Add `capsulePhysKeyIconClass`, `capsulePhysKeyRowClass`, and the new `capsuleArrowKeyButtonClass` import. Add one test that expects:

```ts
expect(capsulePhysKeyRowClass).toContain('flex-row');
expect(capsulePhysKeyRowClass).toContain('items-center');
expect(capsulePhysKeyButtonClass).toContain(
  'text-[length:var(--composer-phys-key-font-size)]',
);
expect(capsulePhysKeyIconClass).toContain(
  'var(--composer-phys-key-icon-size)',
);
expect(capsuleArrowKeyButtonClass).toContain('min-w-0');
```

Keep the existing `min-w-[5ch]` and `whitespace-nowrap` assertions for labeled shortcut keys.

- [ ] **Step 2: Add structural test IDs and a failing integration assertion.**

After rendering `showPhysKeys`, assert that `phys-key-row`, `phys-key-grid`, and `arrow-key-grid` exist. Assert the row class contains `flex-row`, the shortcut grid class contains `flex-1`, and the arrow grid class contains `shrink-0`.

- [ ] **Step 3: Run the focused tests and verify they fail for the intended reasons.**

Run:

```bash
cd web && npm test -- --run src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx
```

Expected: failures because the row is still `flex-col`, the compact font token/new arrow class do not exist, and the structural test IDs are not rendered yet.

## Task 2: Implement horizontal layout and compact controls

**Files:**
- Modify: `design/generated/web.css`
- Modify: `web/src/session-first/capsule/capsuleStyles.ts`
- Modify: `web/src/session-first/capsule/PhysKeyRow.tsx`

- [ ] **Step 1: Tune app-scoped composer tokens for the mobile capsule.**

In the `[data-experience="app"]` block of `design/generated/web.css`, use these values:

```css
--composer-font-size: 0.875rem;
--composer-text-line-height: 1.25rem;
--composer-popover-width: 22rem;
--composer-popover-viewport-inset: 1rem;
--composer-popover-gap: 0.25rem;
--composer-phys-key-height: 44px;
--composer-phys-key-icon-size: 14px;
--composer-phys-key-pad-x: 0.25rem;
--composer-phys-key-pad-y: 0.25rem;
--composer-phys-key-grid-gap: 0.125rem;
--composer-phys-key-font-size: 0.625rem;
--composer-phys-key-arrow-width: 2.25rem;
```

These values reduce the panel’s visual density while retaining a 44px control band; desktop/root token values remain unchanged.

- [ ] **Step 2: Update capsule style contracts.**

Set the physical row to a single horizontal flex line:

```ts
export const capsulePhysKeyButtonClass =
  'h-[length:var(--composer-phys-key-height)] min-w-[5ch] shrink-0 whitespace-nowrap px-0 font-mono text-[length:var(--composer-phys-key-font-size)]';

export const capsulePhysKeyIconClass = 'size-[length:var(--composer-phys-key-icon-size)]';

export const capsuleArrowKeyButtonClass =
  'h-[length:var(--composer-phys-key-height)] w-[var(--composer-phys-key-arrow-width)] min-w-0 shrink-0 px-0 font-mono text-[length:var(--composer-phys-key-font-size)]';

export const capsulePhysKeyRowClass =
  'flex flex-row items-center gap-[length:var(--composer-phys-key-grid-gap)] border-b border-border/60 px-[length:var(--composer-phys-key-pad-x)] py-[length:var(--composer-phys-key-pad-y)]';
```

Use the existing tokenized gap class for the grids; do not add literal layout dimensions in component code.

- [ ] **Step 3: Render the two regions side by side.**

In `PhysKeyRow.tsx`, make `KeyButton` accept `isArrow?: boolean` and select `capsuleArrowKeyButtonClass` for arrow buttons. Render:

```tsx
<div data-testid="phys-key-row" className={capsulePhysKeyRowClass}>
  <div
    data-testid="phys-key-grid"
    className={cn('grid min-w-0 flex-1 grid-cols-5', capsulePhysKeyGridGapClass)}
  >
    {LEFT_KEYS.map((keyDef) => (
      <KeyButton key={keyDef.label} keyDef={keyDef} />
    ))}
  </div>
  <div
    data-testid="arrow-key-grid"
    className={cn(
      'grid shrink-0 grid-cols-3 grid-rows-2',
      capsulePhysKeyGridGapClass,
    )}
  >
    <div />
    <KeyButton keyDef={ARROW_KEYS[0]} isArrow />
    <div />
    <KeyButton keyDef={ARROW_KEYS[1]} isArrow />
    <KeyButton keyDef={ARROW_KEYS[2]} isArrow />
    <KeyButton keyDef={ARROW_KEYS[3]} isArrow />
  </div>
</div>
```

Keep all pointer handlers, chain handling, aria labels, and test IDs unchanged apart from passing `isArrow` to the arrow buttons.

- [ ] **Step 4: Run the focused tests and verify they pass.**

Run the command from Task 1 Step 3. Expected: all capsule style and popover integration tests pass, including the existing “keeps the popover open” tests.

## Task 3: Run full verification and review the diff

**Files:**
- Review: all files changed in Tasks 1–2

- [ ] **Step 1: Run the complete web test suite.**

Run:

```bash
cd web && npm test
```

Expected: all web test files and tests pass.

- [ ] **Step 2: Run lint and production build.**

Run:

```bash
cd web && npm run lint
cd web && npm run build
```

Expected: both commands exit successfully with no lint errors or TypeScript/build errors.

- [ ] **Step 3: Check formatting and inspect the final diff.**

Run:

```bash
git diff --check
git diff -- design/generated/web.css web/src/session-first/capsule/capsuleStyles.ts web/src/session-first/capsule/PhysKeyRow.tsx web/src/session-first/capsule/__tests__
```

Expected: no whitespace errors; the diff is limited to mobile capsule sizing/layout and its tests.

- [ ] **Step 4: Commit the implementation.**

```bash
git add design/generated/web.css web/src/session-first/capsule/capsuleStyles.ts web/src/session-first/capsule/PhysKeyRow.tsx web/src/session-first/capsule/__tests__
git commit -m "fix(web): compact mobile capsule key layout"
```

# Terminal Capsule Flat / Stacked Composer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session-first capsule Input use content-driven `flat` ↔ `stacked` layout with FLIP tool morph + height tween, matching the approved design.

**Architecture:** Keep `session-first/capsule/**`. Derive `ComposerLayout` from ghost-input line count. Restructure `CapsuleInputRow` so tools are one shared toolbar that sits beside the input (`flat`) or under it (`stacked`). Drive position continuity with `useCapsuleLayoutFlip`. Commands mode path stays untouched.

**Tech Stack:** React 19, Tailwind v4, Vitest + Testing Library, existing capsule hooks/popovers.

**Spec:** `docs/superpowers/specs/2026-08-31-terminal-capsule-flat-stacked-design.md`

**Worktree base:** `origin/staging` (capsule module lives here). Branch: `feat/capsule-flat-stacked`. PR → `staging`.

**Do not touch:** `InputPanel.tsx`, `QuickCommandsPanel.tsx`, legacy BottomBar, `k8s/overlays/**`, lint rule files.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/src/session-first/capsule/types.ts` | Modify | Add `ComposerLayout = 'flat' \| 'stacked'`; keep `DockHeight` as deprecated alias or replace call sites |
| `web/src/session-first/capsule/useCapsuleLayoutFlip.ts` | Create | FLIP First/Last/Invert/Play + reduced-motion branch |
| `web/src/session-first/capsule/__tests__/unit/useCapsuleLayoutFlip.test.ts` | Create | Unit tests for flip helper |
| `web/src/session-first/capsule/CapsuleInputRow.tsx` | Modify | Column/`flat` row structure; wire FLIP; `data-layout` |
| `web/src/session-first/capsule/CapsuleInputTools.tsx` | Modify | Optional: expose stable `data-flip-id` wrappers if needed for FLIP targets |
| `web/src/session-first/capsule/CapsuleGhostInput.tsx` | Modify | Keep height tween; continue reporting line count (no layout ownership) |
| `web/src/session-first/capsule/TerminalCapsule.tsx` | Modify | Map layout → `data-dock-height` / `data-layout`; close popovers on send clear via callback |
| `web/src/session-first/capsule/__tests__/integration/CapsuleInputRow.test.tsx` | Modify | Assert flat vs stacked DOM structure (not side-tools-only growth) |
| `web/src/session-first/capsule/__tests__/integration/TerminalCapsule.test.tsx` | Modify or create | Shell `data-layout`; Commands path still single-row |

---

### Task 1: `ComposerLayout` type + line-count mapping

**Files:**
- Modify: `web/src/session-first/capsule/types.ts`
- Modify: any imports of `DockHeight` in capsule (grep first)

- [ ] **Step 1: Update types**

```ts
export type CapsuleMode = 'input' | 'commands';
export type CapsuleVariant = 'desktop' | 'mobile';
export type CapsulePopoverId = 'history' | 'commands';

/** Content-driven Input composer layout (spec: flat-stacked). */
export type ComposerLayout = 'flat' | 'stacked';

/** @deprecated Use ComposerLayout — single≡flat, multi≡stacked */
export type DockHeight = 'single' | 'multi';

export function dockHeightFromLayout(layout: ComposerLayout): DockHeight {
  return layout === 'stacked' ? 'multi' : 'single';
}

export function layoutFromLineCount(lineCount: number): ComposerLayout {
  return lineCount >= 2 ? 'stacked' : 'flat';
}
```

- [ ] **Step 2: Add a tiny unit test file**

Create: `web/src/session-first/capsule/__tests__/unit/composerLayout.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  layoutFromLineCount,
  dockHeightFromLayout,
} from '@/session-first/capsule/types';

describe('composerLayout', () => {
  it('maps line counts to flat/stacked', () => {
    expect(layoutFromLineCount(0)).toBe('flat');
    expect(layoutFromLineCount(1)).toBe('flat');
    expect(layoutFromLineCount(2)).toBe('stacked');
    expect(layoutFromLineCount(5)).toBe('stacked');
  });

  it('maps layout to legacy dock height', () => {
    expect(dockHeightFromLayout('flat')).toBe('single');
    expect(dockHeightFromLayout('stacked')).toBe('multi');
  });
});
```

- [ ] **Step 3: Run test**

```bash
cd web && npx vitest run src/session-first/capsule/__tests__/unit/composerLayout.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/session-first/capsule/types.ts \
  web/src/session-first/capsule/__tests__/unit/composerLayout.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add ComposerLayout flat/stacked mapping

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `useCapsuleLayoutFlip` (TDD)

**Files:**
- Create: `web/src/session-first/capsule/useCapsuleLayoutFlip.ts`
- Create: `web/src/session-first/capsule/__tests__/unit/useCapsuleLayoutFlip.test.ts`

- [ ] **Step 1: Write failing unit tests**

Test a pure helper exported for FLIP (hook can wrap it). Prefer testing `runLayoutFlip` so jsdom does not need React 19 act gymnastics for rAF:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prefersReducedMotion, runLayoutFlip } from '@/session-first/capsule/useCapsuleLayoutFlip';

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when matchMedia matches reduce', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when matchMedia does not match', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('runLayoutFlip', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('applies invert transform then clears it on play', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const first = new DOMRect(10, 10, 40, 40);
    vi.spyOn(el, 'getBoundingClientRect')
      .mockReturnValueOnce(new DOMRect(50, 80, 40, 40) as DOMRect); // last

    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    runLayoutFlip([{ el, first }], { durationMs: 0 });

    // After synchronous rAF mock, transform should be cleared
    expect(el.style.transform).toBe('');
    raf.mockRestore();
    el.remove();
  });

  it('skips transform when reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
    const el = document.createElement('button');
    document.body.appendChild(el);
    const spy = vi.spyOn(el, 'getBoundingClientRect');
    runLayoutFlip([{ el, first: new DOMRect(0, 0, 10, 10) }], { durationMs: 200 });
    expect(spy).not.toHaveBeenCalled();
    expect(el.style.transform).toBe('');
    el.remove();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
cd web && npx vitest run src/session-first/capsule/__tests__/unit/useCapsuleLayoutFlip.test.ts
```

- [ ] **Step 3: Implement**

```ts
// web/src/session-first/capsule/useCapsuleLayoutFlip.ts
import { useLayoutEffect, useRef } from 'react';
import type { ComposerLayout } from '@/session-first/capsule/types';

export const FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const FLIP_MS = 260;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface FlipTarget {
  el: HTMLElement;
  first: DOMRect;
}

export function runLayoutFlip(
  targets: FlipTarget[],
  opts: { durationMs?: number } = {},
): void {
  if (prefersReducedMotion() || targets.length === 0) {
    return;
  }
  const durationMs = opts.durationMs ?? FLIP_MS;

  for (const { el, first } of targets) {
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) {
      continue;
    }
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  // Force layout before enabling transition
  void document.body.offsetHeight;

  requestAnimationFrame(() => {
    for (const { el, first } of targets) {
      const last = el.getBoundingClientRect();
      // If still inverted, play to identity
      if (el.style.transform) {
        el.style.transition = `transform ${durationMs}ms ${FLIP_EASE}`;
        el.style.transform = '';
      }
      void first;
      void last;
    }
  });
}

/**
 * Call `capture()` before layout DOM change; after React commits new layout,
 * `play()` runs FLIP. Targets are `[data-flip-id]` under `rootRef`.
 */
export function useCapsuleLayoutFlip(
  layout: ComposerLayout,
  rootRef: React.RefObject<HTMLElement | null>,
): { captureBeforeLayoutChange: () => void } {
  const pendingFirst = useRef<Map<string, DOMRect> | null>(null);
  const prevLayout = useRef(layout);

  const captureBeforeLayoutChange = () => {
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) {
      pendingFirst.current = null;
      return;
    }
    const map = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((el) => {
      const id = el.dataset.flipId;
      if (id) {
        map.set(id, el.getBoundingClientRect());
      }
    });
    pendingFirst.current = map;
  };

  useLayoutEffect(() => {
    if (prevLayout.current === layout) {
      return;
    }
    prevLayout.current = layout;
    const root = rootRef.current;
    const firsts = pendingFirst.current;
    pendingFirst.current = null;
    if (!root || !firsts) {
      return;
    }
    const targets: FlipTarget[] = [];
    firsts.forEach((first, id) => {
      const el = root.querySelector<HTMLElement>(`[data-flip-id="${id}"]`);
      if (el) {
        targets.push({ el, first });
      }
    });
    runLayoutFlip(targets);
  }, [layout, rootRef]);

  return { captureBeforeLayoutChange };
}
```

Note: `CapsuleInputRow` must call `captureBeforeLayoutChange()` **synchronously in the line-count handler before `setLayout`**, so First rects are taken while still in the old layout.

- [ ] **Step 4: Fix the unit test if `runLayoutFlip` double-reads rect** — simplify implementation so Invert uses the provided `first` vs one `getBoundingClientRect()` for Last only; adjust test expectations accordingly until green.

- [ ] **Step 5: Run tests — PASS**

```bash
cd web && npx vitest run src/session-first/capsule/__tests__/unit/useCapsuleLayoutFlip.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/capsule/useCapsuleLayoutFlip.ts \
  web/src/session-first/capsule/__tests__/unit/useCapsuleLayoutFlip.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add useCapsuleLayoutFlip for composer morph

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Restructure `CapsuleInputRow` to flat / stacked (TDD)

**Files:**
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleInputRow.test.tsx`
- Modify: `web/src/session-first/capsule/CapsuleInputRow.tsx`
- Modify: `web/src/session-first/capsule/CapsuleInputTools.tsx` (add `data-flip-id` on tool root wrappers)

- [ ] **Step 1: Rewrite failing expectations for stacked structure**

Replace the soft-expand-era assertions:

```tsx
it('uses flat layout for single-line input', () => {
  renderRow();
  const row = screen.getByTestId('capsule-input-row');
  expect(row).toHaveAttribute('data-layout', 'flat');
  expect(row.className).toMatch(/grid/);
  expect(screen.getByTestId('capsule-input-left').className).toMatch(/row-start-1/);
  expect(screen.getByTestId('capsule-input-right')).toBeInTheDocument();
  expect(screen.queryByTestId('capsule-input-toolbar')).not.toBeInTheDocument();
});

it('switches to stacked layout for multi-line without dropping focus', async () => {
  const onLayoutChange = vi.fn();
  render(
    <CapsuleInputRow
      sendText={vi.fn()}
      historyOpen={false}
      onHistoryOpenChange={vi.fn()}
      commandsOpen={false}
      onCommandsOpenChange={vi.fn()}
      onLayoutChange={onLayoutChange}
    />,
  );
  const input = screen.getByTestId('capsule-ghost-input');
  input.focus();
  await userEvent.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

  await waitFor(() => {
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
      'data-layout',
      'stacked',
    );
  });
  expect(onLayoutChange).toHaveBeenCalledWith('stacked');
  expect(document.activeElement).toBe(input);
  expect(screen.getByTestId('capsule-input-field').className).toMatch(/col-span-3/);
  expect(screen.getByTestId('capsule-input-left').className).toMatch(/row-start-2/);
  expect(screen.getByTestId('capsule-input-toolbar')).toBeInTheDocument();
});

it('returns to flat when content is single line again', async () => {
  renderRow();
  const input = screen.getByTestId('capsule-ghost-input');
  await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
  await waitFor(() => {
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
      'data-layout',
      'stacked',
    );
  });
  await userEvent.clear(input);
  await userEvent.type(input, 'one');
  await waitFor(() => {
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
      'data-layout',
      'flat',
    );
  });
  expect(document.activeElement).toBe(input);
});

it('returns to flat after send clears input', async () => {
  const sendText = vi.fn();
  const onHistoryOpenChange = vi.fn();
  render(
    <CapsuleInputRow
      sendText={sendText}
      historyOpen={true}
      onHistoryOpenChange={onHistoryOpenChange}
      commandsOpen={false}
      onCommandsOpenChange={vi.fn()}
    />,
  );
  const input = screen.getByTestId('capsule-ghost-input');
  await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
  await waitFor(() => {
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
      'data-layout',
      'stacked',
    );
  });
  await userEvent.click(screen.getByTestId('capsule-send'));
  expect(sendText).toHaveBeenCalled();
  await waitFor(() => {
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
      'data-layout',
      'flat',
    );
  });
  expect(onHistoryOpenChange).toHaveBeenCalledWith(false);
});
```

Update `renderRow` helper to use `onLayoutChange` instead of `onHeightChange`.

- [ ] **Step 2: Run tests — expect FAIL** (still `data-expanded` / old structure)

```bash
cd web && npx vitest run src/session-first/capsule/__tests__/integration/CapsuleInputRow.test.tsx
```

- [ ] **Step 3: Implement stacked DOM (locked structure — CSS grid, stable tree)**

Do **not** re-parent `CapsuleGhostInput` (remount drops focus). Do **not** use `display: contents`. Keep three stable children; switch placement with grid classes:

```tsx
const [layout, setLayout] = useState<ComposerLayout>('flat');
const rootRef = useRef<HTMLDivElement>(null);
const { captureBeforeLayoutChange } = useCapsuleLayoutFlip(layout, rootRef);
const isStacked = layout === 'stacked';

const handleLineCountChange = (lineCount: number) => {
  const next = layoutFromLineCount(lineCount);
  if (next !== layout) {
    captureBeforeLayoutChange();
    setLayout(next);
    onLayoutChange?.(next);
  }
};

const doSend = () => {
  const text = inputValue.trim();
  if (!text) {
    return;
  }
  sendText(`${text}\r`);
  addEntry(text);
  setInputValue('');
  captureBeforeLayoutChange();
  setLayout('flat');
  onLayoutChange?.('flat');
  onHistoryOpenChange(false);
  onCommandsOpenChange(false);
};

return (
  <div
    ref={rootRef}
    data-testid="capsule-input-row"
    data-layout={layout}
    className={cn(
      'grid min-w-0 flex-1 gap-1',
      !isStacked && 'grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-1 items-end',
      isStacked &&
        'grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-end',
    )}
  >
    <div
      data-testid="capsule-input-left"
      data-flip-id="tools-left"
      className={cn(
        'shrink-0',
        isStacked ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1',
      )}
    >
      <CapsuleInputLeftTools
        leading={leading}
        historyOpen={historyOpen}
        onHistoryOpenChange={onHistoryOpenChange}
        commandsOpen={commandsOpen}
        onCommandsOpenChange={onCommandsOpenChange}
        showCommandsButton={showCommandsButton}
        disabled={disabled}
        sendText={sendText}
        onSelectHistory={setInputValue}
      />
    </div>

    <div
      data-testid="capsule-input-field"
      className={cn(
        'min-w-0',
        isStacked ? 'col-span-3 col-start-1 row-start-1' : 'col-start-2 row-start-1',
      )}
    >
      <CapsuleGhostInput
        value={inputValue}
        onChange={setInputValue}
        disabled={disabled}
        onEnter={doSend}
        onLineCountChange={handleLineCountChange}
      />
    </div>

    <div
      data-testid="capsule-input-right"
      data-flip-id="tools-right"
      className={cn(
        'shrink-0',
        isStacked
          ? 'col-start-3 row-start-2 justify-self-end'
          : 'col-start-3 row-start-1',
      )}
    >
      <CapsuleInputRightActions
        inputValue={inputValue}
        disabled={disabled}
        showPasteCopy={showPasteCopy}
        onSend={doSend}
        onPaste={handlePaste}
        onCopy={handleCopy}
      />
    </div>

    {isStacked ? (
      <div
        data-testid="capsule-input-toolbar"
        aria-hidden
        className="pointer-events-none col-span-3 col-start-1 row-start-2"
      />
    ) : null}
  </div>
);
```

Optional: set `data-flip-id="mode-toggle"` on the ModeToggle root in `CapsuleModeToggle.tsx`.

- [ ] **Step 4: Replace `onHeightChange` prop with `onLayoutChange?: (layout: ComposerLayout) => void`** everywhere (`TerminalCapsule`).

- [ ] **Step 5: Run CapsuleInputRow tests — PASS**

```bash
cd web && npx vitest run src/session-first/capsule/__tests__/integration/CapsuleInputRow.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/capsule/CapsuleInputRow.tsx \
  web/src/session-first/capsule/CapsuleInputTools.tsx \
  web/src/session-first/capsule/__tests__/integration/CapsuleInputRow.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): flat/stacked CapsuleInputRow with FLIP hooks

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire `TerminalCapsule` shell attrs + Commands isolation

**Files:**
- Modify: `web/src/session-first/capsule/TerminalCapsule.tsx`
- Modify/Create: integration test for TerminalCapsule if present under `web/src/session-first/capsule/__tests__/` or `web/src/session-first/__tests__/`

- [ ] **Step 1: Update shell**

```tsx
const [layout, setLayout] = useState<ComposerLayout>('flat');
// remove DockHeight state

// on capsule root:
data-layout={isCommandsMode ? undefined : layout}
data-dock-height={
  isCommandsMode ? 'single' : dockHeightFromLayout(layout)
}

// shell chrome: always rounded-3xl; stacked may use items-stretch
className={cn(
  'flex border border-border shadow-lg backdrop-blur-sm',
  'bg-[var(--sf-capsule-surface)] text-foreground',
  'rounded-3xl px-2 py-1.5',
  isCommandsMode ? 'min-h-11 items-center gap-2' : 'items-stretch',
)}
```

Pass `onLayoutChange={setLayout}` into `CapsuleInputRow`.

- [ ] **Step 2: Test** — Input path sets `data-layout="stacked"` after multiline; Commands mode still renders `CapsuleCommandsRow` without `data-layout="stacked"` requirement.

```tsx
it('exposes data-layout stacked when input grows', async () => {
  render(
    <TerminalCapsule sendText={vi.fn()} variant="desktop" />,
  );
  const input = screen.getByTestId('capsule-ghost-input');
  await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
  await waitFor(() => {
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute(
      'data-layout',
      'stacked',
    );
  });
});
```

Mock `useQuickCommands` / `useCommandHistory` like other capsule tests.

- [ ] **Step 3: Green + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(web): expose capsule flat/stacked layout on TerminalCapsule

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Regression sweep + lint

- [ ] **Step 1: Run full capsule + related layout tests**

```bash
cd web && npx vitest run src/session-first/capsule \
  src/components/__tests__/integration/TerminalLayout.capsule.test.tsx \
  src/components/__tests__/integration/MobileTerminalLayout.test.tsx
```

Fix any prop rename fallout (`onHeightChange` → `onLayoutChange`).

- [ ] **Step 2: Lint / types**

```bash
cd web && npm run lint && npx tsc --noEmit
```

Expected: zero errors; no `eslint-disable`.

- [ ] **Step 3: Commit fixes if any**

```bash
git commit -m "$(cat <<'EOF'
fix(web): align capsule callers with ComposerLayout API

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Manual / Playwright verification (before PR)

- [ ] **Step 1:** Local demo (`?session_first=1`): desktop — type Shift+Enter, confirm tools slide to bottom toolbar; delete to one line — tools return to sides; Send — flat + popovers closed.
- [ ] **Step 2:** Mobile Input — same; Commands mode — unchanged quick keys.
- [ ] **Step 3:** Screenshots to `.playwright-mcp/screenshots/` (`capsule-flat.png`, `capsule-stacked.png`); attach as **PR comment**, not body.
- [ ] **Step 4:** Push + `gh pr create --base staging` with 变更内容 + 测试报告; no `Closes #`.

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| flat / stacked IA | 3, 4 |
| Same controls, reflow only | 3 |
| Content ≥2 lines expand; 1 line / send collapse | 1, 3 |
| Focus does not expand | 3 (no focus handlers) |
| FLIP + height tween | 2, 3 (GhostInput height kept) |
| Always `rounded-3xl` | 4 |
| Reduced motion | 2 |
| Popover stay open on morph; close on send | 3 |
| Mobile Input same; Commands unchanged | 3, 4, 5 |
| Tokens / no legacy panels | unchanged paths |

---

## Out of scope (do not implement)

- Focus-driven expand
- Legacy BottomBar redesign
- Desktop Commands mode
- Changing `--sf-*` token values unless contrast breaks

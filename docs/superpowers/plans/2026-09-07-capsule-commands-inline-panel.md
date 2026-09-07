# Capsule Commands Inline Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mobile App commands overflow Sheet with a dock-attached 20vh inline panel (no blur), tap-terminal-to-dismiss, and reliable button taps.

**Architecture:** Extract shared `CapsuleCommandsPanel` from the popover body. `CapsuleCommandsRow` renders the panel inline below the quick-key bar; More is a plain button toggle. `CapsuleCommandsDismissLayer` mounts inside `[data-terminal-capsule-host]` at `z-10` when `commandsOpen`, covering xterm above the dock. `useCapsuleDockClearance` already tracks dock height via `ResizeObserver` — panel expansion increases dock height automatically. Web Input keeps `CapsuleCommandsPopover` with `presentation="popover"`.

**Tech Stack:** React 19, Tailwind v4 + design tokens, Vitest + Testing Library, Playwright MCP (staging screenshots).

**Spec:** `docs/superpowers/specs/2026-09-07-capsule-commands-inline-panel-design.md`

**Worktree base:** `origin/staging`. Branch: `feat/capsule-commands-inline-panel`. PR → `staging`.

**Do not touch:** lint rules, `InputPanel.tsx`, legacy BottomBar, gitops/k8s.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `design/tokens/experience/app.json` | Modify | Add `commandsPanelMaxHeight: 20vh` |
| `design/generated/web.css` | Regenerate | `--composer-commands-panel-max-height` |
| `web/src/session-first/capsule/capsuleStyles.ts` | Modify | Panel + dismiss layer classes; remove sheet classes |
| `web/src/session-first/capsule/CapsuleCommandsPanel.tsx` | Create | Inline panel chrome + body (header, close, scroll list) |
| `web/src/session-first/capsule/CapsuleCommandsDismissLayer.tsx` | Create | Transparent hit target above dock |
| `web/src/session-first/capsule/CapsuleCommandsRow.tsx` | Modify | Inline panel + plain More toggle |
| `web/src/session-first/capsule/CapsuleCommandsPopover.tsx` | Modify | Popover-only; remove Sheet branch |
| `web/src/session-first/capsule/components/CapsuleShell.tsx` | Modify | Column layout + capsule radius when panel open |
| `web/src/session-first/capsule/TerminalCapsule.tsx` | Modify | Mount dismiss layer on host |
| `web/src/index.css` | Modify | Remove capsule sheet z-index overrides |
| `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx` | Modify | Inline panel assertions |
| `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx` | Modify | Remove sheet test |
| `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsDismissLayer.test.tsx` | Create | Dismiss behavior |
| `web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts` | Modify | Panel token class assertion |

---

### Task 1: App design token — 20vh panel max height

**Files:**
- Modify: `design/tokens/experience/app.json`
- Regenerate: `design/generated/web.css` (via script)

- [ ] **Step 1: Add token to app.json**

In `design/tokens/experience/app.json`, inside `"composer"`, after `"popoverMaxHeight"`:

```json
"commandsPanelMaxHeight": { "value": "20vh" },
```

- [ ] **Step 2: Regenerate CSS**

Run: `node design/scripts/generate-tokens.mjs`

Expected: `design/generated/web.css` contains under `[data-experience="app"]`:

```css
--composer-commands-panel-max-height: 20vh;
```

- [ ] **Step 3: Commit**

```bash
git add design/tokens/experience/app.json design/generated/web.css
git commit -m "feat: add app composer commandsPanelMaxHeight token (20vh)"
```

---

### Task 2: Panel and dismiss layer style classes

**Files:**
- Modify: `web/src/session-first/capsule/capsuleStyles.ts`
- Modify: `web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts`

- [ ] **Step 1: Write failing style test**

Add to `capsuleStyles.test.ts`:

```ts
import { capsuleCommandsPanelClass, capsuleCommandsDismissLayerClass } from '@/session-first/capsule/capsuleStyles';

it('uses 20vh commands panel max-height token', () => {
  expect(capsuleCommandsPanelClass).toContain('var(--composer-commands-panel-max-height)');
});

it('dismiss layer sits below capsule dock z-index', () => {
  expect(capsuleCommandsDismissLayerClass).toContain('z-10');
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd web && npx vitest run src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts`

- [ ] **Step 3: Add exports to capsuleStyles.ts**

Remove `capsuleSheetOverlayClass` and `capsuleSheetContentClass` if present. Add:

```ts
export const capsuleCommandsPanelClass =
  'flex max-h-[length:var(--composer-commands-panel-max-height)] flex-col overflow-hidden border-t border-border/60 bg-popover text-popover-foreground rounded-t-xl';

export const capsuleCommandsPanelHeaderClass =
  'flex items-center justify-between gap-[length:var(--composer-popover-gap)] p-[length:var(--composer-popover-pad)]';

export const capsuleCommandsPanelListClass =
  'min-h-0 flex-1 overflow-y-auto max-h-[length:var(--composer-commands-panel-max-height)]';

export const capsuleCommandsDismissLayerClass =
  'absolute inset-x-0 top-0 z-10 cursor-default';
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/capsule/capsuleStyles.ts web/src/session-first/capsule/__tests__/unit/capsuleStyles.test.ts
git commit -m "feat: add capsule inline commands panel style classes"
```

---

### Task 3: `CapsuleCommandsPanel` component

**Files:**
- Create: `web/src/session-first/capsule/CapsuleCommandsPanel.tsx`
- Modify: `web/src/session-first/capsule/CapsuleCommandsPopover.tsx` (extract shared body)

- [ ] **Step 1: Write failing integration test**

Create `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsPanel } from '@/session-first/capsule/CapsuleCommandsPanel';

vi.mock('@/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

describe('CapsuleCommandsPanel', () => {
  it('renders inline panel with close button and phys keys', async () => {
    const onClose = vi.fn();
    render(
      <CapsuleCommandsPanel
        sendText={vi.fn()}
        disabled={false}
        showPhysKeys
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('capsule-commands-panel')).toBeInTheDocument();
    expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close commands' }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd web && npx vitest run src/session-first/capsule/__tests__/integration/CapsuleCommandsPanel.test.tsx`

- [ ] **Step 3: Implement CapsuleCommandsPanel.tsx**

Move `CapsuleCommandsPanelBody` logic from `CapsuleCommandsPopover.tsx` into the new file. Structure:

```tsx
export function CapsuleCommandsPanel({
  sendText,
  disabled = false,
  showPhysKeys,
  onClose,
}: {
  sendText: (text: string) => void;
  disabled?: boolean;
  showPhysKeys: boolean;
  onClose: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const commands = useCapsuleCommands(sendText);
  // handleRun closes via onClose(); phys keys stay open
  return (
    <>
      <div data-testid="capsule-commands-panel" className={capsuleCommandsPanelClass}>
        <div className={capsuleCommandsPanelHeaderClass}>
          <h2 className="text-sm font-medium">Quick commands</h2>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close commands" onClick={onClose}>
            <X />
          </Button>
        </div>
        {/* body: chain bar, PhysKeyRow, scroll list, add command — reuse existing item classes */}
      </div>
      <CapsuleAddCommandDialog ... />
    </>
  );
}
```

Keep `capsulePopoverBodyClass` / `capsulePopoverItemClass` for list items (same visual chrome).

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/capsule/CapsuleCommandsPanel.tsx web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPanel.test.tsx
git commit -m "feat: add CapsuleCommandsPanel inline component"
```

---

### Task 4: `CapsuleCommandsDismissLayer`

**Files:**
- Create: `web/src/session-first/capsule/CapsuleCommandsDismissLayer.tsx`
- Create: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsDismissLayer.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { CapsuleCommandsDismissLayer } from '@/session-first/capsule/CapsuleCommandsDismissLayer';

function HostFixture({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const dockRef = useRef<HTMLDivElement>(null);
  return (
    <div data-terminal-capsule-host style={{ position: 'relative', height: 400 }}>
      {open ? (
        <CapsuleCommandsDismissLayer dockRef={dockRef} onDismiss={onDismiss} />
      ) : null}
      <div ref={dockRef} data-testid="mock-dock" style={{ position: 'absolute', bottom: 0, height: 120, width: '100%' }} />
    </div>
  );
}

describe('CapsuleCommandsDismissLayer', () => {
  it('calls onDismiss when terminal area above dock is clicked', async () => {
    const onDismiss = vi.fn();
    render(<HostFixture open onDismiss={onDismiss} />);
    const layer = screen.getByTestId('capsule-commands-dismiss-layer');
    expect(layer).toBeInTheDocument();
    await userEvent.click(layer);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not render when closed', () => {
    render(<HostFixture open={false} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('capsule-commands-dismiss-layer')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement dismiss layer**

```tsx
export function CapsuleCommandsDismissLayer({
  dockRef,
  onDismiss,
}: {
  dockRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const [bottomPx, setBottomPx] = useState(0);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    const host = dock?.closest('[data-terminal-capsule-host]');
    if (!dock || !(host instanceof HTMLElement)) return;

    const update = () => {
      const hostRect = host.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      setBottomPx(Math.max(0, hostRect.bottom - dockRect.top));
    };
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    observer.observe(host);
    update();
    return () => observer.disconnect();
  }, [dockRef]);

  return (
    <button
      type="button"
      data-testid="capsule-commands-dismiss-layer"
      aria-label="Close commands menu"
      className={capsuleCommandsDismissLayerClass}
      style={{ bottom: bottomPx }}
      onClick={onDismiss}
    />
  );
}
```

Use `<button type="button">` for a11y; no visible label text (aria-label only). Background transparent.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/capsule/CapsuleCommandsDismissLayer.tsx web/src/session-first/capsule/__tests__/integration/CapsuleCommandsDismissLayer.test.tsx
git commit -m "feat: add tap-terminal dismiss layer for commands panel"
```

---

### Task 5: Wire inline panel into `CapsuleCommandsRow`

**Files:**
- Modify: `web/src/session-first/capsule/CapsuleCommandsRow.tsx`
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx`

- [ ] **Step 1: Update failing tests**

Replace sheet assertions in `CapsuleCommandsRow.test.tsx`:

```tsx
it('opens inline panel when more trigger is clicked', async () => {
  // ... same as before, expect onOpenChange(true)
});

it('renders inline panel when commandsOpen', () => {
  render(<CapsuleCommandsRow ... commandsOpen />);
  expect(screen.getByTestId('capsule-commands-panel')).toBeInTheDocument();
  expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeInTheDocument();
  expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Refactor CapsuleCommandsRow**

```tsx
// More trigger — plain button, no SheetTrigger
<CapsuleCommandsMoreTrigger
  disabled={disabled}
  aria-expanded={commandsOpen}
  onClick={() => onCommandsOpenChange(!commandsOpen)}
/>
// Below the row, inside flex-col:
{commandsOpen ? (
  <CapsuleCommandsPanel
    sendText={sendText}
    disabled={disabled}
    showPhysKeys
    onClose={() => onCommandsOpenChange(false)}
  />
) : null}
```

Remove `CapsuleCommandsPopover` import from this file entirely.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/capsule/CapsuleCommandsRow.tsx web/src/session-first/capsule/__tests__/integration/CapsuleCommandsRow.test.tsx
git commit -m "feat: render commands overflow as inline dock panel"
```

---

### Task 6: Simplify `CapsuleCommandsPopover` (popover-only)

**Files:**
- Modify: `web/src/session-first/capsule/CapsuleCommandsPopover.tsx`
- Modify: `web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`

- [ ] **Step 1: Remove sheet test; keep popover tests**

Delete `it('renders bottom sheet when presentation is sheet', ...)`.

Add test that default still uses popover portal:

```tsx
expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument();
```

- [ ] **Step 2: Remove Sheet imports and sheet branch**

- Delete `presentation?: 'popover' | 'sheet'` — only popover remains OR keep prop but only `'popover'` value for backward compat in `CapsuleInputTools`.
- Reuse `CapsuleCommandsPanel` body inside `PopoverContent` OR keep slim wrapper calling shared list from panel — prefer wrapping existing popover header + importing list section from panel to avoid duplication.

Minimal approach: PopoverContent renders same inner content as before (PopoverHeader + body extracted to shared module if not already).

- [ ] **Step 3: Run popover tests — expect PASS**

Run: `cd web && npx vitest run src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx`

- [ ] **Step 4: Commit**

```bash
git add web/src/session-first/capsule/CapsuleCommandsPopover.tsx web/src/session-first/capsule/__tests__/integration/CapsuleCommandsPopover.test.tsx
git commit -m "refactor: remove sheet presentation from CapsuleCommandsPopover"
```

---

### Task 7: `CapsuleShell` column layout when panel open

**Files:**
- Modify: `web/src/session-first/capsule/components/CapsuleShell.tsx`

- [ ] **Step 1: Read commandsOpen from context**

```tsx
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';

// inside CapsuleShell:
const ctx = useCapsuleContext();
const commandsExpanded = isCommandsMode && ctx?.commandsOpen;
```

- [ ] **Step 2: Adjust shell layout**

When `commandsExpanded`:
- Outer dock: keep `pointer-events-none` on outer, `pointer-events-auto` on inner shell
- Inner shell: `flex-col items-stretch` instead of single-row `items-center`
- Shape: use `capsuleShellCapsuleRadiusClass` (not pill) when panel open
- Content wrapper: `flex-col` so mode toggle row + commands row stack correctly

When collapsed commands mode: keep current pill + single row.

- [ ] **Step 3: Manual smoke**

Run: `cd web && npm run dev` — not required for CI; rely on tests.

- [ ] **Step 4: Commit**

```bash
git add web/src/session-first/capsule/components/CapsuleShell.tsx
git commit -m "feat: capsule shell column layout when commands panel open"
```

---

### Task 8: Mount dismiss layer in `TerminalCapsule`

**Files:**
- Modify: `web/src/session-first/capsule/TerminalCapsule.tsx`

- [ ] **Step 1: Import dismiss layer and context values**

After `CapsuleProvider` wraps content, the dismiss layer needs `commandsOpen` + `setCommandsOpen`. Render inside provider:

```tsx
<CapsuleProvider value={...}>
  {isCommandsMode && restState.commandsOpen ? (
    <CapsuleCommandsDismissLayer
      dockRef={dockRef}
      onDismiss={() => restState.setCommandsOpen(false)}
    />
  ) : null}
  <CapsuleShell ...>
```

Dismiss layer must be a **child of** `[data-terminal-capsule-host]`. `TerminalCapsule` is rendered inside the host in `MobileTerminalLayout`. If dismiss layer is sibling of `CapsuleShell` inside provider, both are inside host — OK.

Verify: dismiss layer is NOT inside `pointer-events-none` outer dock — it renders before/alongside CapsuleShell but outside the outer pointer-events-none wrapper. **Render dismiss layer as direct child of host** using `createPortal` if CapsuleShell outer is pointer-events-none:

```tsx
// In TerminalCapsule, portal dismiss to host:
const host = dockRef.current?.closest('[data-terminal-capsule-host]');
return createPortal(<CapsuleCommandsDismissLayer ... />, host);
```

Only when `host && isCommandsMode && commandsOpen`.

- [ ] **Step 2: Integration test with host wrapper**

Extend `CapsuleCommandsDismissLayer.test.tsx` or add `TerminalCapsule` test with `[data-terminal-capsule-host]` wrapper verifying dismiss closes panel state (mock `setCommandsOpen`).

- [ ] **Step 3: Commit**

```bash
git add web/src/session-first/capsule/TerminalCapsule.tsx
git commit -m "feat: mount commands dismiss layer on terminal host"
```

---

### Task 9: Cleanup sheet artifacts

**Files:**
- Modify: `web/src/index.css`
- Modify: `web/src/components/ui/sheet.tsx` (only if overlayClassName was added solely for capsule — keep generic improvements)

- [ ] **Step 1: Remove capsule sheet CSS overrides**

Delete from `web/src/index.css`:

```css
/* Capsule commands sheet — content above blurred overlay ... */
.session-first-shell [data-slot='sheet-portal']:has(...);
```

- [ ] **Step 2: Grep for dead references**

Run: `rg 'capsuleSheet|presentation="sheet"|presentation=.sheet' web/src`

Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add web/src/index.css
git commit -m "chore: remove capsule sheet z-index overrides"
```

---

### Task 10: Full verification gate

- [ ] **Step 1: Web lint + tests**

```bash
cd web && npm run lint && npm test -- --run src/session-first/capsule
```

Expected: all pass, 0 warnings.

- [ ] **Step 2: Rust quick check (pre-push will run full suite on new branch)**

```bash
just quick && just web-lint
```

- [ ] **Step 3: Update spec status**

In `docs/superpowers/specs/2026-09-07-capsule-commands-inline-panel-design.md`, set `Status: Implemented`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-07-capsule-commands-inline-panel-design.md
git commit -m "docs: mark inline commands panel spec implemented"
```

---

### Task 11: PR to staging + visual proof

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/capsule-commands-inline-panel
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --base staging --title "feat: inline commands panel for mobile App capsule" --body "..."
gh pr merge --auto --merge
```

- [ ] **Step 3: Playwright MCP screenshots (after merge + staging deploy)**

- Commands mode, panel open: terminal visible above panel, no blur
- Tap dismiss layer: panel closes
- Save to `.playwright-mcp/screenshots/capsule-inline-panel-*.png`
- Post as PR comment

- [ ] **Step 4: deploy-watch**

```bash
./scripts/deploy-watch.sh staging
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Inline panel, no portal Sheet | 5, 6 |
| 20vh max height token | 1, 2 |
| No blur / no overlay | 5, 6, 9 |
| Tap terminal dismiss | 4, 8 |
| Quick keys onClick | 5 (already plain Button) |
| PhysKeyRow in panel | 3 |
| Occlusion sync | Automatic via existing `useCapsuleDockClearance` + expanded dock |
| Web popover unchanged | 6 |
| Remove sheet presentation | 6, 9 |
| Tests | 2–5, 8, 10 |
| Playwright staging proof | 11 |

## Self-review notes

- **Occlusion:** No new hook needed — `dockRef` on `CapsuleShell` outer dock already includes panel height when inline panel is a child of the dock tree.
- **Dismiss layer portal:** Task 8 explicitly uses portal to host to avoid `pointer-events-none` on dock outer.
- **Duplication:** Task 3 + 6 share panel body — extract shared `CapsuleCommandsPanelBody` in same file or `CapsuleCommandsPanelContent.tsx` if Popover still needs it.
- **CapsuleInputTools:** Continues passing `presentation` default popover — no change required.

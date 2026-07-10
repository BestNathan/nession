# Terminal Responsive Layout & UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal operation page responsive across three breakpoints, replace the fixed-height bottom bar with a content-adaptive capped one, and give the send box a fixed-height multi-line input.

**Architecture:** CSS-only responsive via Tailwind breakpoint prefixes (`sm:` = tablet ≥640px, `lg:` = desktop ≥1024px; base = mobile <640px). No JS breakpoint hook. Drawer open/closed stays React state. xterm refit is already automatic — `ViewportManager`'s `ResizeObserver` (`web/src/terminal/ViewportManager.ts:27-33`) fits on every container size change, and `FileTabs`' `onTerminalReveal` covers the hidden→visible case (`web/src/components/FileTabs.tsx:160-166`).

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui (`Textarea`, `Button`), Vitest + Testing Library, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-07-10-terminal-responsive-layout-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `web/src/components/TerminalToolbar.tsx` | Quick commands + send input | Replace single-line `<Input>` with fixed 3-row `<Textarea>`; Enter submits / Shift+Enter newline (unit-tested) |
| `web/src/components/__tests__/TerminalToolbar.test.tsx` | Toolbar unit tests | Update input tests for textarea; add multi-line submit test |
| `web/src/components/SidePanel.tsx` | Collapsible file-browser panel | Overlay (drawer + backdrop) below `lg`, inline+resizable at `lg` (unit-tested) |
| `web/src/components/__tests__/SidePanel.test.tsx` | SidePanel unit tests | Add backdrop present-when-open + backdrop-click-closes tests |
| `web/src/components/TerminalView.tsx` | Page layout / `BottomBar` glue | Drop `h-[116px]` → `max-h-[40vh]`; add mobile bottom-sheet state; responsive header (glue — excluded from coverage, verified by build + Playwright) |

**Coverage note:** `TerminalView.tsx` and `FileTabs.tsx` are excluded from Vitest coverage as glue (see `web/vite.config.ts` `test.coverage.exclude`). `TerminalToolbar.tsx` and `SidePanel.tsx` ARE unit-tested — keep them green.

**Before starting:** confirm you are on branch `feat/terminal-responsive-layout` (`git branch --show-current`), not `main`.

---

## Task 1: Multi-line input in TerminalToolbar

**Files:**
- Modify: `web/src/components/TerminalToolbar.tsx:1-11` (imports), `:47-52` (`sendInput`), `:93-109` (input row)
- Test: `web/src/components/__tests__/TerminalToolbar.test.tsx`

**Submit semantics:** the textarea value (which may contain `\n` from Shift+Enter) is sent verbatim with a single trailing `\r` — i.e. `sendText(value + '\r')`. This matches the current single-line behavior; only the input widget and key handling change.

- [ ] **Step 1: Update the input tests for a textarea**

Replace the three existing input tests (`sends text from input on Enter`, `sends text on Send button click`, `disables input when disabled prop is true`) and the `Shift+Enter does not send in input` test. Open `web/src/components/__tests__/TerminalToolbar.test.tsx` and replace those four `it(...)` blocks (currently at lines 66-95 and 116-123) with:

```tsx
  it('sends text from textarea on Enter', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/);
    await user.type(input, 'ls -la{Enter}');
    expect(sendText).toHaveBeenCalledWith('ls -la\r');
  });

  it('sends text on Send button click', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/);
    await user.type(input, 'pwd');
    await user.click(screen.getByTitle('Send'));
    expect(sendText).toHaveBeenCalledWith('pwd\r');
  });

  it('Shift+Enter inserts a newline and does not send', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/) as HTMLTextAreaElement;
    await user.type(input, 'line1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(sendText).not.toHaveBeenCalled();
    expect(input.value).toBe('line1\n');
  });

  it('sends a multi-line block as literal text plus trailing CR', async () => {
    const user = userEvent.setup();
    const { sendText } = renderToolbar();
    const input = screen.getByPlaceholderText(/Type to send/);
    await user.type(input, 'cd /tmp{Shift>}{Enter}{/Shift}ls{Enter}');
    expect(sendText).toHaveBeenCalledWith('cd /tmp\nls\r');
  });

  it('disables textarea when disabled prop is true', () => {
    renderToolbar({ disabled: true });
    const input = screen.getByPlaceholderText(/Type to send/);
    expect(input).toBeDisabled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/TerminalToolbar.test.tsx`
Expected: FAIL — the multi-line test fails (single-line `<Input>` ignores Shift+Enter newline; value won't contain `\n`), and `input.value` assertions fail.

- [ ] **Step 3: Swap the Input import for Textarea**

In `web/src/components/TerminalToolbar.tsx`, change the import at line 4 from:

```tsx
import { Input } from './ui/input';
```

to:

```tsx
import { Textarea } from './ui/textarea';
```

- [ ] **Step 4: Rewrite the input row to use a fixed-height textarea**

Replace the input row block (`web/src/components/TerminalToolbar.tsx:93-109`) with:

```tsx
      {/* Input row — pinned to bottom; multi-line, fixed ~3 rows */}
      <div className="flex gap-1.5 flex-shrink-0 p-2 pt-1 border-t items-end">
        <Textarea
          placeholder="Type to send… (Enter to submit, Shift+Enter for newline)"
          value={inputValue}
          rows={3}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendInput();
            }
          }}
          className="text-xs flex-1 min-h-0 h-[4.5rem] resize-none [field-sizing:fixed] py-1.5"
          disabled={disabled}
        />
        <Button variant="outline" size="icon" className="h-7 w-7 flex-shrink-0" title="Send"
          onClick={sendInput} disabled={disabled}>
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
```

Notes: `[field-sizing:fixed]` overrides the `field-sizing-content` (auto-grow) baked into `ui/textarea.tsx:10`, so the box stays a fixed 3-row height (`h-[4.5rem]`) and scrolls internally instead of growing. `resize-none` disables the drag handle. `items-end` keeps the Send button aligned to the textarea's bottom.

- [ ] **Step 5: Confirm `sendInput` handles multi-line correctly (no change expected)**

Verify `web/src/components/TerminalToolbar.tsx:47-52` reads:

```tsx
  const sendInput = () => {
    const text = inputValue.trim();
    if (!text) { return; }
    sendText(text + '\r');
    setInputValue('');
  };
```

This already sends `value + '\r'`. `String.prototype.trim()` strips only leading/trailing whitespace and preserves interior `\n`, so `'cd /tmp\nls'` → `sendText('cd /tmp\nls\r')`. No edit needed. (If the multi-line test still fails after Step 4, the cause is the widget, not this function.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/TerminalToolbar.test.tsx`
Expected: PASS — all TerminalToolbar tests green, including the multi-line and Shift+Enter cases.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TerminalToolbar.tsx web/src/components/__tests__/TerminalToolbar.test.tsx
git commit -m "feat: multi-line fixed-height terminal send input

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Content-adaptive, capped bottom bar

**Files:**
- Modify: `web/src/components/TerminalView.tsx:178` (`BottomBar` root), `:205` (content wrapper)
- Modify: `web/src/components/TerminalToolbar.tsx:55` (outer), `:57` (command list)

**No unit test:** `BottomBar` lives in `TerminalView.tsx` (glue, coverage-excluded). Verified by build + the Playwright pass in Task 5. `TerminalToolbar` edits here are structural (class-only) and don't change its tested behavior.

- [ ] **Step 1: Make the bottom bar size to content with a 40vh cap**

In `web/src/components/TerminalView.tsx`, change the `BottomBar` root (line 178) from:

```tsx
    <div className="border-t flex-shrink-0 flex flex-col h-[116px]">
```

to:

```tsx
    <div className="border-t flex-shrink-0 flex flex-col max-h-[40vh]">
```

Dropping the fixed `h-[116px]` lets the bar shrink to its content; `max-h-[40vh]` caps it so the terminal always keeps ≥60vh. The terminal sibling (`flex-1 min-h-0`) absorbs the freed space automatically.

- [ ] **Step 2: Let the active-panel region scroll when capped**

In the same `BottomBar` (line 205), change:

```tsx
      <div className="flex-1 min-h-0 overflow-hidden">
```

to:

```tsx
      <div className="flex-1 min-h-0 overflow-y-auto">
```

When content exceeds the 40vh cap, this region scrolls while the tab strip stays pinned.

- [ ] **Step 3: Stop the toolbar from assuming a fixed parent height**

In `web/src/components/TerminalToolbar.tsx`, change the outer wrapper (line 55) from:

```tsx
    <div className="flex flex-col h-full">
```

to:

```tsx
    <div className="flex flex-col min-h-0">
```

and the quick-command list (line 57) from:

```tsx
      <div className="flex flex-wrap gap-1 content-start overflow-y-auto flex-1 min-h-0 p-2 pb-0">
```

to:

```tsx
      <div className="flex flex-wrap gap-1 content-start overflow-y-auto min-h-0 p-2 pb-0">
```

Removing `h-full` / `flex-1` lets the toolbar size to its content (wrapped command rows + fixed input row) so the bottom bar is short when there are few commands, and only grows/scrolls under the 40vh cap when there are many.

- [ ] **Step 4: Build and type-check**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: PASS — no type errors, build succeeds.

- [ ] **Step 5: Run the full web test suite (regression check)**

Run: `cd web && npx vitest run`
Expected: PASS — all tests green (Task 1 tests + untouched suites).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TerminalView.tsx web/src/components/TerminalToolbar.tsx
git commit -m "feat: content-adaptive capped bottom bar (drop fixed 116px)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: SidePanel overlay drawer below `lg`

**Files:**
- Modify: `web/src/components/SidePanel.tsx:58-101` (render)
- Test: `web/src/components/__tests__/SidePanel.test.tsx`

**Behavior:** at `lg` (desktop) the panel is inline and pushes width + is resizable (unchanged). Below `lg` (mobile/tablet) it is a fixed overlay drawer with a dismissable backdrop; the resize handle is hidden. CSS does the push-vs-overlay switch; a backdrop element + click-to-close is added.

- [ ] **Step 1: Write the failing backdrop tests**

Append these tests inside the `describe('SidePanel', …)` block in `web/src/components/__tests__/SidePanel.test.tsx` (before the closing `});`):

```tsx
  it('renders a backdrop when open', () => {
    const { container } = render(
      <SidePanel defaultOpen={true}>
        <div>Content</div>
      </SidePanel>,
    );
    expect(container.querySelector('[data-testid="sidepanel-backdrop"]')).toBeTruthy();
  });

  it('does not render a backdrop when closed', () => {
    const { container } = render(
      <SidePanel defaultOpen={false}>
        <div>Content</div>
      </SidePanel>,
    );
    expect(container.querySelector('[data-testid="sidepanel-backdrop"]')).toBeFalsy();
  });

  it('closes when the backdrop is clicked', () => {
    const { container } = render(
      <SidePanel defaultOpen={true}>
        <div>Content</div>
      </SidePanel>,
    );
    const backdrop = container.querySelector('[data-testid="sidepanel-backdrop"]')!;
    fireEvent.click(backdrop);
    expect(screen.getByTitle('Open panel')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/SidePanel.test.tsx`
Expected: FAIL — no element with `data-testid="sidepanel-backdrop"` exists yet.

- [ ] **Step 3: Add the backdrop and overlay classes**

Replace the entire `return (…)` block in `web/src/components/SidePanel.tsx` (lines 58-101) with:

```tsx
  return (
    <>
      {/* Backdrop — only below lg, only when open. Dismisses the drawer. */}
      {isOpen && (
        <div
          data-testid="sidepanel-backdrop"
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      <div className="relative flex-shrink-0">
        {/* Panel content — fixed overlay below lg, inline (push) at lg+ */}
        <div
          className={cn(
            'border-r bg-muted/30 transition-all duration-200 overflow-hidden',
            'fixed inset-y-0 left-0 z-30 lg:static lg:z-auto lg:h-full',
            isOpen ? '' : 'w-0 border-r-0',
          )}
          style={{ width: isOpen ? width : 0 }}
        >
          <div className="h-full flex flex-col" style={{ width }}>
            {children}
          </div>

          {/* Resize handle — desktop only (push mode) */}
          {isOpen && (
            <div
              className="absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-10 hidden lg:block"
              style={{ right: -2 }}
              onMouseDown={startResize}
            />
          )}
        </div>

        {/* Toggle button */}
        <button
          onClick={toggle}
          className={cn(
            'fixed lg:absolute top-1/2 -translate-y-1/2 h-16 w-5 flex items-center justify-center',
            'border shadow-sm cursor-pointer transition-all z-40',
            isOpen
              ? 'bg-muted rounded-r-md hover:bg-accent lg:-right-5'
              : 'left-0 bg-background/60 rounded-r-md hover:bg-accent/80 opacity-50 hover:opacity-100',
          )}
          style={isOpen ? { left: width } : undefined}
          title={isOpen ? 'Close panel' : 'Open panel'}
        >
          {isOpen ? (
            <ChevronLeft className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </>
  );
```

Notes: below `lg`, the content div is `fixed` (out of flow) so the wrapper collapses to 0 width and the terminal keeps full width while the panel overlays. At `lg+`, `lg:static lg:h-full` puts it back in flow so it pushes width and the existing resize handle (`hidden lg:block`) reappears — the `.cursor-col-resize` element is still in the DOM (just hidden), so the existing resize tests keep passing. When open below `lg`, the toggle button is `fixed` at `left: width` (the drawer's right edge); at `lg+`, `lg:absolute lg:-right-5` restores desktop positioning.

- [ ] **Step 4: Run the SidePanel tests to verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/SidePanel.test.tsx`
Expected: PASS — new backdrop tests pass and all pre-existing tests (resize handle, toggle, width) stay green.

- [ ] **Step 5: Build and type-check**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SidePanel.tsx web/src/components/__tests__/SidePanel.test.tsx
git commit -m "feat: SidePanel overlay drawer with backdrop below lg breakpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Responsive header + mobile bottom sheet in TerminalView

**Files:**
- Modify: `web/src/components/TerminalView.tsx:47-52` (state), `:100-122` (header), `:166-210` (`BottomBar`)

**No unit test:** `TerminalView.tsx` is glue (coverage-excluded). Verified by build + Playwright (Task 5). On mobile the bottom bar collapses to its tab strip and expands as an overlay sheet; on `sm:`+ it is always inline (Task 2 behavior).

- [ ] **Step 1: Add mobile bottom-sheet open state**

In `web/src/components/TerminalView.tsx`, add a state line after line 51 (`const [bottomTab, setBottomTab] = useState<'commands' | 'env'>('commands');`):

```tsx
  const [sheetOpen, setSheetOpen] = useState(false);
```

- [ ] **Step 2: Make the header wrap on small screens**

Change the header opening tag (`web/src/components/TerminalView.tsx:102`) from:

```tsx
      <header className="border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
```

to:

```tsx
      <header className="border-b px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-4 flex-shrink-0 flex-wrap">
```

`flex-wrap` lets the mode badge + route selector drop to a second line on narrow screens instead of overflowing; tighter padding/gap reclaims width on mobile.

- [ ] **Step 3: Pass sheet state into BottomBar and make it responsive**

Replace the `BottomBar` component (`web/src/components/TerminalView.tsx:166-210`) with:

```tsx
function BottomBar({
  activeTab,
  onTabChange,
  envPanel,
  commandsPanel,
  sheetOpen,
  onSheetToggle,
}: {
  activeTab: 'commands' | 'env';
  onTabChange: (tab: 'commands' | 'env') => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
}) {
  // Mobile: tapping a tab both selects it and opens the sheet.
  const selectTab = (tab: 'commands' | 'env') => {
    onTabChange(tab);
    onSheetToggle(true);
  };

  return (
    <div className="border-t flex-shrink-0 flex flex-col max-h-[70vh] sm:max-h-[40vh]">
      <div className="flex border-b items-center">
        <button
          type="button"
          onClick={() => selectTab('commands')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            activeTab === 'commands'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <TerminalIcon className="w-3 h-3" /> Commands
        </button>
        <button
          type="button"
          onClick={() => selectTab('env')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            activeTab === 'env'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Package className="w-3 h-3" /> Env
        </button>
        {/* Mobile-only collapse control for the sheet */}
        {sheetOpen && (
          <button
            type="button"
            onClick={() => onSheetToggle(false)}
            className="ml-auto px-3 py-1 text-xs text-muted-foreground hover:text-foreground sm:hidden"
            title="Collapse"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/* Content: always shown at sm+; on mobile only when the sheet is open */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-y-auto',
          sheetOpen ? 'block' : 'hidden sm:block',
        )}
      >
        {activeTab === 'env' ? envPanel : commandsPanel}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the `ChevronDown` import**

In `web/src/components/TerminalView.tsx`, update the lucide import (line 2) from:

```tsx
import { ArrowLeft, TerminalIcon, Package } from 'lucide-react';
```

to:

```tsx
import { ArrowLeft, TerminalIcon, Package, ChevronDown } from 'lucide-react';
```

- [ ] **Step 5: Pass the new props at both BottomBar call sites**

`BottomBar` is rendered twice (`web/src/components/TerminalView.tsx:132-142` inside `FileTabs`, and `:149-156` in the no-fileOps branch). Add the two new props to BOTH. The first call site becomes:

```tsx
                <BottomBar
                  activeTab={bottomTab}
                  onTabChange={setBottomTab}
                  sheetOpen={sheetOpen}
                  onSheetToggle={setSheetOpen}
                  envPanel={<EnvPanel wsService={wsService} sessionId={sessionId} />}
                  commandsPanel={
                    <TerminalToolbar
                      sendText={(text) => terminalRef.current?.sendText(text)}
                      disabled={toolbarDisabled}
                    />
                  }
                />
```

The second call site becomes:

```tsx
            <BottomBar
              activeTab={bottomTab}
              onTabChange={setBottomTab}
              sheetOpen={sheetOpen}
              onSheetToggle={setSheetOpen}
              envPanel={<EnvPanel wsService={wsService} sessionId={sessionId} />}
              commandsPanel={
                <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
              }
            />
```

- [ ] **Step 6: Build, type-check, lint, and full test run**

Run: `cd web && npx tsc --noEmit && npm run build && npm run lint && npx vitest run`
Expected: PASS — no type errors, build succeeds, ESLint clean with `--max-warnings 0`, all tests green.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TerminalView.tsx
git commit -m "feat: responsive header + mobile bottom sheet in terminal view

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Visual verification (Playwright) + final gates

**Files:** none (verification only). Screenshots saved to `.playwright-mcp/screenshots/` (gitignored).

- [ ] **Step 1: Start the local demo stack**

Run each in the background from repo root (isolated HOME so it doesn't touch `~/.nession`):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```

Server: `127.0.0.1:19090` (ws) + `:10080` (http); agent `:19091`; web `http://localhost:13000`. tmux must be installed for the agent.

- [ ] **Step 2: Log in and attach to a session**

Use Playwright MCP:
- `mcp__playwright__browser_navigate` → `http://localhost:13000`
- In the browser console run `localStorage.clear()` then reload to drop stale prefilled values (use `mcp__playwright__browser_evaluate`).
- Log in with any non-empty token.
- Create a tmux session if none exists (Create Session dialog), then Attach to reach the terminal page.

- [ ] **Step 3: Capture desktop (>1024px)**

- `mcp__playwright__browser_resize` → width `1440`, height `900`.
- `mcp__playwright__browser_take_screenshot` → `filename: screenshots/terminal-desktop.png` (file browser open pushing width; Commands bottom bar inline and short).
- Open the Env tab; screenshot → `screenshots/terminal-desktop-env.png` (list scrolls under the 40vh cap).

- [ ] **Step 4: Capture tablet (640–1024px)**

- `mcp__playwright__browser_resize` → width `820`, height `1100`.
- Open the file browser (should overlay the terminal with a backdrop, NOT push width); screenshot → `screenshots/terminal-tablet-drawer.png`.
- Dismiss via backdrop; screenshot with bottom bar inline → `screenshots/terminal-tablet.png`.

- [ ] **Step 5: Capture mobile (<640px)**

- `mcp__playwright__browser_resize` → width `390`, height `844`.
- Screenshot terminal-first with the bottom bar collapsed to its tab strip → `screenshots/terminal-mobile.png`.
- Tap the Commands tab to expand the sheet; type a two-line command (`cd /tmp`, Shift+Enter, `ls`) into the multi-line input; screenshot → `screenshots/terminal-mobile-sheet.png`.
- Open the file-browser drawer (overlay + backdrop); screenshot → `screenshots/terminal-mobile-drawer.png`.

- [ ] **Step 6: Verify multi-line send works end-to-end**

With the two-line command entered on any breakpoint, press Enter and confirm both `cd /tmp` and `ls` execute in the live terminal (prompt shows `/tmp` then directory listing). Screenshot → `screenshots/terminal-multiline-result.png`.

- [ ] **Step 7: Tear down the stack**

```bash
pkill -f 'target/debug/nession-(server|agent)'
pkill -f vite
```

- [ ] **Step 8: Final verification gates**

Run: `cd web && npm run build && npm run lint && npx tsc --noEmit && npx vitest run && npm run coverage`
Expected: build OK; ESLint clean (`--max-warnings 0`, no `eslint-disable`); no TS errors; all tests pass; coverage ≥ 80% lines/functions/statements, ≥ 65% branches.

- [ ] **Step 9: Push and open the PR**

```bash
git push -u origin feat/terminal-responsive-layout
gh pr create --title "feat: responsive terminal layout, adaptive bottom bar, multi-line input" --body "$(cat <<'EOF'
## Summary
- Responsive terminal page across 3 breakpoints (mobile <640 / tablet 640–1024 / desktop >1024)
- File-browser side panel: overlay drawer + backdrop below lg; inline resizable push at lg+
- Bottom bar: content-adaptive height capped at 40vh (was fixed 116px); scrolls when capped
- Send box: fixed 3-row multi-line textarea (Enter submits, Shift+Enter newline)

## 核心功能截图
Desktop: `.playwright-mcp/screenshots/terminal-desktop.png`, `terminal-desktop-env.png`
Tablet: `.playwright-mcp/screenshots/terminal-tablet.png`, `terminal-tablet-drawer.png`
Mobile: `.playwright-mcp/screenshots/terminal-mobile.png`, `terminal-mobile-sheet.png`, `terminal-mobile-drawer.png`
Multi-line: `.playwright-mcp/screenshots/terminal-multiline-result.png`

## Test plan
- `npm run build && npm run lint && npx tsc --noEmit && npx vitest run && npm run coverage` all pass
- Manual Playwright verification at all three breakpoints

Spec: `docs/superpowers/specs/2026-07-10-terminal-responsive-layout-design.md`
Plan: `docs/superpowers/plans/2026-07-10-terminal-responsive-layout.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Responsive matrix → Tasks 3 (side panel overlay/push) + 4 (header wrap, mobile sheet); bottom bar adaptive+capped → Task 2; multi-line input → Task 1; refit (no new wiring, relies on existing `ResizeObserver`) → documented in Architecture, verified in Task 5 Step 3-6. Screenshots at 3 breakpoints → Task 5.
- **Cap values:** 40vh inline is applied in Task 2. Task 4 Step 3 finalizes the `BottomBar` root as `max-h-[70vh] sm:max-h-[40vh]`, matching the spec (mobile sheet up to ~70vh since it overlays and is dismissable; 40vh inline at tablet/desktop). Task 2's flat `max-h-[40vh]` is an intermediate value superseded by Task 4.
- **Type consistency:** `sheetOpen: boolean` / `onSheetToggle: (open: boolean) => void` defined in Task 4 Step 3 and passed identically at both call sites in Step 5. `setSheetOpen` from Step 1 matches `onSheetToggle`'s signature.
- **No placeholders:** every code step shows complete code and exact file:line targets.

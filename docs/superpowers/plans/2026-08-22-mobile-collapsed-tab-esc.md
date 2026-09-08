# Mobile Collapsed Input Bar: Tab/Esc + Scrollable Shortcuts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tab and Esc shortcut buttons to the mobile collapsed input bar, and make the shortcut row horizontally scrollable when buttons overflow.

**Architecture:** Extend the collapsed-state toolbar in `TerminalInputBar` (inside `MobileTerminalLayout.tsx`) from 5 to 7 buttons. Wrap the button row in a scroll container with `overflow-x-auto` and fixed button widths (`h-9 w-9`) so it degrades gracefully on narrow viewports. No changes to the expanded-state layout, desktop layout, or protocol.

**Tech Stack:** React 18 + TypeScript, Tailwind v4, shadcn/ui `Button`, Vitest + `@testing-library/react` for unit tests, Playwright MCP for functional verification.

**Issue:** BestNathan/nession#377

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `web/src/components/MobileTerminalLayout.tsx` | Collapsed-state toolbar: add Tab/Esc buttons, wrap in scroll container |
| Modify | `web/src/components/__tests__/integration/MobileTerminalLayout.test.tsx` | Test new buttons render, send correct sequences, honor `disabled`, scroll container present |

**Files NOT touched:** expanded-state layout, desktop `BottomBar`/`FileTabs`, `QuickCommandsPanel`, server protocol.

---

## Current state (for reference)

Collapsed toolbar JSX (in `TerminalInputBar`, `MobileTerminalLayout.tsx`):

```tsx
{collapsed ? (
  <>
    <span className="text-xs text-muted-foreground font-medium select-none">
      Input
    </span>
    <div className="flex-1" />

    {/* Quick-action buttons — 5 equal-size touch targets */}
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('\x03')} disabled={disabled} aria-label="Ctrl-C"><Square className="size-4" data-icon /></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand(' ')} disabled={disabled} aria-label="Space"><span className="text-[11px] font-mono font-bold">⎵</span></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('\r')} disabled={disabled} aria-label="Enter"><CornerDownLeft className="size-4" data-icon /></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('clear\n')} disabled={disabled} aria-label="Clear"><Trash2 className="size-4" data-icon /></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('\x12')} disabled={disabled} aria-label="Ctrl-R"><Search className="size-4" data-icon /></Button>
  </>
) : ( /* ... expanded ... */ )}
```

Sequences used by `QuickCommandsPanel` (reference):
- Tab: `\t`
- Esc: `\x1b`

---

## Task 1: Tests for Tab/Esc buttons + scroll container

**Files:**
- Modify: `web/src/components/__tests__/integration/MobileTerminalLayout.test.tsx`

- [ ] **Step 1.1: Add a controller mock to the test setup**

The new buttons dispatch through `controller.handleInput`, so the test setup needs a stub controller. Update `setup()` to accept and pass a mock controller:

```tsx
function setup(
  terminalElement: React.ReactNode = <div data-testid="terminal" />,
  options: { toolbarDisabled?: boolean; controller?: Pick<TerminalController, 'handleInput'> | null } = {},
) {
  const { toolbarDisabled = false, controller = null } = options;
  const onScrollPages = vi.fn();
  const onScrollToBottom = vi.fn();
  render(
    <MobileTerminalLayout
      terminalElement={terminalElement}
      sessionId="session-1"
      sendText={vi.fn()}
      toolbarDisabled={toolbarDisabled}
      onScrollPages={onScrollPages}
      onScrollToBottom={onScrollToBottom}
      controller={controller as TerminalController | null | undefined}
    />,
  );
  return { onScrollPages, onScrollToBottom };
}
```

Add the import at the top of the test file:

```tsx
import type { TerminalController } from '@/terminal/controller/TerminalController';
```

- [ ] **Step 1.2: Write the failing tests**

Append these inside the `describe('MobileTerminalLayout', ...)` block:

```tsx
describe('collapsed toolbar shortcut buttons', () => {
  it('renders Tab and Esc buttons alongside the original five', () => {
    setup();
    // Original five
    expect(screen.getByRole('button', { name: 'Ctrl-C' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Space' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ctrl-R' })).toBeInTheDocument();
    // New two
    expect(screen.getByRole('button', { name: 'Tab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Esc' })).toBeInTheDocument();
  });

  it('Tab button sends \\t via controller.handleInput', () => {
    const handleInput = vi.fn();
    setup(<div data-testid="terminal" />, { controller: { handleInput } });
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledWith(
      expect.objectContaining({ data: '\t' }),
    );
  });

  it('Esc button sends \\x1b via controller.handleInput', () => {
    const handleInput = vi.fn();
    setup(<div data-testid="terminal" />, { controller: { handleInput } });
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledWith(
      expect.objectContaining({ data: '\x1b' }),
    );
  });

  it('all shortcut buttons are disabled when toolbarDisabled=true', () => {
    setup(<div data-testid="terminal" />, { toolbarDisabled: true });
    for (const label of ['Ctrl-C', 'Space', 'Enter', 'Clear', 'Ctrl-R', 'Tab', 'Esc']) {
      const btn = screen.getByRole('button', { name: label });
      expect(btn).toBeDisabled();
    }
  });

  it('shortcut row is a horizontally scrollable container', () => {
    const { container } = setup();
    // The scroll container is the parent of the shortcut buttons.
    const tabButton = screen.getByRole('button', { name: 'Tab' });
    const row = tabButton.parentElement;
    expect(row).not.toBeNull();
    // overflow-x-auto produces overflowX === 'auto' (or 'scroll') in computed style —
    // but jsdom does not compute Tailwind. Assert the Tailwind class is present instead.
    expect(row?.className).toMatch(/overflow-x-auto/);
    // Silence unused-var lint for the test helper return.
    void container;
  });
});
```

- [ ] **Step 1.3: Run tests to verify they fail**

```bash
cd web && npx vitest run src/components/__tests__/integration/MobileTerminalLayout.test.tsx
```

Expected: the new `describe` block fails — `Tab`/`Esc` buttons not found in DOM (only 5 buttons exist today).

- [ ] **Step 1.4: Commit the failing tests**

```bash
git add web/src/components/__tests__/integration/MobileTerminalLayout.test.tsx
git commit -m "test: cover Tab/Esc buttons + scroll container on collapsed toolbar

Issue: #377"
```

---

## Task 2: Add Tab/Esc buttons with scroll container

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx`

- [ ] **Step 2.1: Wrap the collapsed buttons in a scroll container and add Tab/Esc**

Locate the collapsed-state JSX inside `TerminalInputBar` (the `{collapsed ? ( ... ) : ...}` ternary). Replace the "Quick-action buttons" block with 7 buttons wrapped in a scroll container. Replace:

```tsx
{collapsed ? (
  <>
    <span className="text-xs text-muted-foreground font-medium select-none">
      Input
    </span>
    <div className="flex-1" />

    {/* Quick-action buttons — 5 equal-size touch targets */}
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('\x03')} disabled={disabled} aria-label="Ctrl-C"><Square className="size-4" data-icon /></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand(' ')} disabled={disabled} aria-label="Space"><span className="text-[11px] font-mono font-bold">⎵</span></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('\r')} disabled={disabled} aria-label="Enter"><CornerDownLeft className="size-4" data-icon /></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('clear\n')} disabled={disabled} aria-label="Clear"><Trash2 className="size-4" data-icon /></Button>
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => handleQuickCommand('\x12')} disabled={disabled} aria-label="Ctrl-R"><Search className="size-4" data-icon /></Button>
  </>
) : (
```

with:

```tsx
{collapsed ? (
  <>
    <span className="text-xs text-muted-foreground font-medium select-none">
      Input
    </span>
    <div className="flex-1" />

    {/* Quick-action buttons — fixed-width touch targets, scrollable when overflow */}
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand('\x03')} disabled={disabled} aria-label="Ctrl-C"><Square className="size-4" data-icon /></Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand(' ')} disabled={disabled} aria-label="Space"><span className="text-[11px] font-mono font-bold">⎵</span></Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand('\r')} disabled={disabled} aria-label="Enter"><CornerDownLeft className="size-4" data-icon /></Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand('\t')} disabled={disabled} aria-label="Tab"><span className="text-[11px] font-mono font-bold">⇥</span></Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand('\x1b')} disabled={disabled} aria-label="Esc"><span className="text-[11px] font-mono font-bold">⎋</span></Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand('clear\n')} disabled={disabled} aria-label="Clear"><Trash2 className="size-4" data-icon /></Button>
      <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0" onClick={() => handleQuickCommand('\x12')} disabled={disabled} aria-label="Ctrl-R"><Search className="size-4" data-icon /></Button>
    </div>
  </>
) : (
```

Notes on the change:
- Order: Ctrl-C, Space, Enter, **Tab, Esc** (new, inserted before Clear/Ctrl-R since they're "primary edit keys"), Clear, Ctrl-R. This groups the text-modification keys together and puts destructive/utility keys at the trailing end.
- Each button: `h-9 w-9 flex-shrink-0` — fixed 36px×36px (≥40px touch target with padding), `flex-shrink-0` prevents compression inside the scroll container.
- Container: `flex items-center gap-1.5 overflow-x-auto scrollbar-none` — horizontal scroll when content overflows, hidden scrollbar for clean look.
- Tab glyph `⇥` (U+21E5) and Esc glyph `⎋` (U+238B) match the existing Space glyph `⎵` (U+23B5) style — monospaced, 11px, bold.
- Sequences match `QuickCommandsPanel`: Tab = `\t`, Esc = `\x1b`.
- `disabled={disabled}` already propagated — when `toolbarDisabled=true`, all 7 buttons are disabled.

- [ ] **Step 2.2: Hide the scrollbar utility**

Tailwind v4 doesn't ship `scrollbar-none` by default. Add a tiny utility to `web/src/index.css` (inside the existing `@layer base` or at the bottom of the file):

```css
/* Hide scrollbar for horizontal shortcut rows (mobile collapsed toolbar) */
.scrollbar-none {
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* IE/Edge */
}
.scrollbar-none::-webkit-scrollbar {
  display: none; /* Chrome/Safari */
}
```

If `index.css` already contains a similar utility (e.g., for another scroll area), reuse it instead of adding a duplicate.

- [ ] **Step 2.3: Run tests to verify they pass**

```bash
cd web && npx vitest run src/components/__tests__/integration/MobileTerminalLayout.test.tsx
```

Expected: all 5 new tests pass, no regressions in existing tests.

- [ ] **Step 2.4: Run full web quality gates**

```bash
cd web
npm run lint          # 0 warnings
npx tsc --noEmit      # 0 errors
npm run build         # success
npm test              # all pass
```

- [ ] **Step 2.5: Commit the implementation**

```bash
git add web/src/components/MobileTerminalLayout.tsx web/src/index.css
git commit -m "feat(mobile): add Tab/Esc buttons with scrollable shortcut row

Collapsed input bar now shows 7 fixed-width shortcut buttons
(Ctrl-C, Space, Enter, Tab, Esc, Clear, Ctrl-R). Row scrolls
horizontally when content overflows; no tab switching in collapsed
state. Expanded panel and desktop layout unchanged.

Issue: #377"
```

---

## Task 3: Playwright functional verification (MANDATORY)

**This task cannot be skipped. UI/interaction changes require real-browser verification.**

- [ ] **Step 3.1: Start the local stack**

Three terminals from the worktree root:

```bash
# Terminal 1 — server
HOME=/tmp/nession-demo cargo run -p nession-server

# Terminal 2 — agent (needs tmux)
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml

# Terminal 3 — web
cd web && npm run dev
```

Web at `http://localhost:13000`. In browser devtools, run `localStorage.clear()` once. Log in with any non-empty token.

- [ ] **Step 3.2: Resize to mobile viewport**

Use `mcp__playwright__browser_resize` to `width: 375, height: 667` (iPhone SE class) and a second check at `width: 320, height: 568` (smallest target from issue constraints).

- [ ] **Step 3.3: Verify collapsed toolbar state**

Using `mcp__playwright__browser_snapshot` and `mcp__playwright__browser_take_screenshot`:

1. Confirm the input bar is collapsed by default (no 30vh panel visible).
2. Confirm 7 shortcut buttons are visible: Ctrl-C, Space, Enter, Tab, Esc, Clear, Ctrl-R.
3. Confirm no tab strip (Quick | Keys) appears — single row only.
4. On 320px width: confirm buttons do not compress; if row overflows, confirm horizontal scroll works by swiping/dragging the row.

- [ ] **Step 3.4: Verify button behavior**

Attach to a session, focus the terminal, then:

1. Click Tab → expect `\t` in terminal (visible as indentation or completion trigger).
2. Click Esc → expect `\x1b` in terminal (visible as mode cancel in vim, or no-op in shell).
3. Click each of the original 5 buttons → behavior unchanged.

- [ ] **Step 3.5: Verify expanded state is unchanged**

Click the expand chevron → confirm 30vh panel opens with Input | Commands tabs. Confirm behavior identical to before the change.

- [ ] **Step 3.6: Verify `toolbarDisabled` path**

Temporarily disconnect the session (or trigger the disabled state via the UI) → confirm all 7 buttons are visually disabled and do not fire.

- [ ] **Step 3.7: Collect screenshots**

Save to `.playwright-mcp/screenshots/issue-377-*.png`. These will be posted as a PR comment, not in the body.

- [ ] **Step 3.8: Clean up local stack**

```bash
pkill -f 'target/debug/nession-(server|agent)'
pkill -f vite
```

---

## Task 4: Push, PR, merge

- [ ] **Step 4.1: Push the branch**

```bash
git push -u origin feat/mobile-collapsed-tab-esc
```

- [ ] **Step 4.2: Create PR targeting staging**

```bash
gh pr create --base staging \
  --title "feat(mobile): add Tab/Esc buttons with scrollable shortcut row" \
  --body "$(cat <<'BODY'
## 变更内容
- 移动端 input 收起态工具栏新增 Tab (⇥) 和 Esc (⎋) 两个快捷按钮，共 7 个
- 快捷按钮行改为固定宽度 + 横向可滑动容器（`overflow-x-auto`），窄屏不挤压
- Tab 发送 `\t`、Esc 发送 `\x1b`，与 QuickCommandsPanel KeyRow 一致
- 展开态、桌面端布局、协议均不变
- Closes #377 (in release PR)

## 测试报告
- `npm test`: all passed
- `npm run lint`: 0 warnings
- `npx tsc --noEmit`: 0 errors
- `npm run build`: success
- Playwright functional verification: 375px + 320px viewports, all 7 buttons render and fire; scroll works; expanded state unchanged
BODY
)"
```

Note: `Closes #377` is noted in 变更内容 for the release audit but the keyword only fires when merged to `main`. The release PR body will carry the functional `Closes #377` line.

- [ ] **Step 4.3: Post screenshots as PR comment**

```bash
gh pr comment <PR-NUMBER> --body "## 核心功能截图

![375px collapsed toolbar](.playwright-mcp/screenshots/issue-377-375-collapsed.png)
![320px scrolled](.playwright-mcp/screenshots/issue-377-320-scrolled.png)
![expanded unchanged](.playwright-mcp/screenshots/issue-377-expanded.png)"
```

- [ ] **Step 4.4: Enable auto-merge**

```bash
gh pr merge <PR-NUMBER> --auto --merge
```

- [ ] **Step 4.5: After merge — cleanup worktree**

```bash
cd <project-root>
git fetch origin && git checkout main && git pull --ff-only origin main
git worktree remove .claude/worktrees/feat-mobile-collapsed-tab-esc
git worktree prune
git branch -d feat/mobile-collapsed-tab-esc
```

Or use `ExitWorktree` with action `remove`.

# Mobile Dashboard — Horizontal Agent Strip + Compact Session Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On viewports <768px, replace the collapsible agent summary bar with an always-visible horizontally scrollable agent strip, and replace full-width session action buttons with compact icon-only controls.

**Architecture:** Pure CSS/Tailwind responsive change in two components — no new hooks, no state, no protocol changes. `AgentSection` drops its `expanded` state and renders a mobile-only horizontal strip (`overflow-x-auto scrollbar-none`, fixed-width `w-64` cards, `flex-shrink-0`) plus the existing `md+` grid (unchanged breakpoints). `SessionList` `SessionRow` buttons drop `flex-1`, get square 44px touch targets on mobile (`min-h-11 min-w-11`), icon-only labels below `md` (with `aria-label` for accessibility), and keep today's desktop appearance (`md:min-h-7 md:min-w-0`, text labels). Reference scroll pattern: `MobileTerminalLayout.tsx` (overflow-x-auto scrollbar-none + flex-shrink-0 items).

**Tech Stack:** React 19, Tailwind v4, shadcn/ui Button/Tooltip/Card, lucide-react icons, Vitest + Testing Library.

**Issue:** #452 (requirement — mobile dashboard agent strip & session actions). Claims: `in-progress` on #452.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `web/src/components/AgentSection.tsx` | Rewrite body | Mobile strip + desktop grid, drop summary bar/`expanded` |
| `web/src/components/SessionList.tsx` | Modify `SessionRow` actions | Compact icon-only mobile buttons |
| `web/src/components/SessionsSection.tsx` | Review only | Create button already compact (min-h-11) — **no change** |
| `web/src/components/DashboardMainView.tsx` | Modify call site | Stop passing `onlineCount`/`offlineCount` to `AgentSection` (counts live in header SearchBar chips) |
| `web/src/components/__tests__/integration/Dashboard.test.tsx` | Rewrite | Summary-bar tests → strip tests |
| `web/src/components/__tests__/integration/SessionList.test.tsx` | Add tests | Mobile compact button assertions |

**Out of scope:** Rust crates, protocol, `AgentCard` content, `AgentDetailPanel`, terminal pages, sort/filter semantics.

---

### Task 1: Mobile agent strip in AgentSection (TDD)

**Files:**
- Test: `web/src/components/__tests__/integration/Dashboard.test.tsx` (rewrite)
- Modify: `web/src/components/AgentSection.tsx` (rewrite body)
- Modify: `web/src/components/DashboardMainView.tsx:69-79` (drop two props at call site)

- [ ] **Step 1: Rewrite the failing tests — replace the summary-bar describe block**

Replace the entire contents of `web/src/components/__tests__/integration/Dashboard.test.tsx` with:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentSection } from '@/components/Dashboard';
import type { Agent } from '@/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-01',
    display_name: 'prod-box',
    ip_address: '10.0.0.1',
    port: 8080,
    status: 'online',
    session_count: 3,
    active_sessions: 2,
    last_heartbeat: new Date().toISOString(),
    registered_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    metadata: {
      tmux_version: '3.3',
      os_version: 'Linux 6.1',
      nession_version: '0.3.0',
    },
    ...overrides,
  };
}

describe('AgentSection (mobile strip)', () => {
  const baseProps = {
    loadingAgents: false,
    agents: [] as Agent[],
    filteredAgents: [] as Agent[],
    isSearchActive: false,
    setSelectedAgent: vi.fn(),
  };

  const twoAgents = [
    makeAgent({ agent_id: 'agent-1', display_name: 'prod-box' }),
    makeAgent({ agent_id: 'agent-2', display_name: 'dev-box' }),
  ];

  it('renders a horizontally scrollable agent strip instead of a summary bar', () => {
    render(<AgentSection {...baseProps} agents={twoAgents} filteredAgents={twoAgents} />);

    expect(screen.queryByTestId('agent-summary-bar')).not.toBeInTheDocument();
    const strip = screen.getByTestId('agent-strip');
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).toContain('scrollbar-none');
  });

  it('renders every agent card in the strip without shrinking', () => {
    render(<AgentSection {...baseProps} agents={twoAgents} filteredAgents={twoAgents} />);

    expect(screen.getByText('prod-box')).toBeInTheDocument();
    expect(screen.getByText('dev-box')).toBeInTheDocument();
    const firstCard = screen.getByTestId('agent-strip').firstElementChild;
    expect(firstCard?.className).toContain('flex-shrink-0');
  });

  it('hides the desktop grid below md and shows it from md up', () => {
    render(<AgentSection {...baseProps} agents={twoAgents} filteredAgents={twoAgents} />);

    const grid = screen.getByTestId('agent-grid');
    expect(grid.className).toContain('hidden');
    expect(grid.className).toContain('md:grid');
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/integration/Dashboard.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="agent-strip"]` (current component still renders the summary bar).

- [ ] **Step 3: Implement the strip in AgentSection**

Replace the entire contents of `web/src/components/AgentSection.tsx` with:

```tsx
import type { Agent } from '../types';
import { AgentCard } from './AgentCard';
import { Skeleton } from './ui/skeleton';

export function AgentSection({
  loadingAgents,
  agents,
  filteredAgents,
  isSearchActive,
  setSelectedAgent,
  onAgentRename,
  onAgentDelete,
}: {
  loadingAgents: boolean;
  agents: Agent[];
  filteredAgents: Agent[];
  isSearchActive: boolean;
  setSelectedAgent: (a: Agent | null) => void;
  onAgentRename?: (updated: Agent) => void;
  onAgentDelete?: (agent: Agent) => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Agents</h2>
      </div>
      {loadingAgents ? (
        <div className="flex md:grid gap-3 overflow-x-auto scrollbar-none md:overflow-visible md:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 w-64 flex-shrink-0 md:w-auto rounded-xl" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No agents connected</p>
      ) : filteredAgents.length === 0 && isSearchActive ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No agents match your search</p>
      ) : (
        <>
          {/* Mobile: always-visible horizontal strip — swipe through agents (issue #452). */}
          <div
            data-testid="agent-strip"
            className="flex gap-3 overflow-x-auto scrollbar-none -mx-3 px-3 pb-1 md:hidden"
          >
            {filteredAgents.map((a) => (
              <div key={a.agent_id} className="w-64 flex-shrink-0">
                <AgentCard
                  agent={a}
                  onClick={() => setSelectedAgent(a)}
                  onRename={onAgentRename}
                  onDelete={onAgentDelete}
                />
              </div>
            ))}
          </div>
          {/* Desktop: responsive grid (md+), unchanged. */}
          <div data-testid="agent-grid" className="hidden md:grid gap-3 md:grid-cols-3 lg:grid-cols-4">
            {filteredAgents.map((a) => (
              <AgentCard
                key={a.agent_id}
                agent={a}
                onClick={() => setSelectedAgent(a)}
                onRename={onAgentRename}
                onDelete={onAgentDelete}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Drop the now-unused props at the call site**

In `web/src/components/DashboardMainView.tsx`, edit the `<AgentSection ...>` call (lines 69-79): remove the two lines

```tsx
          onlineCount={onlineCount}
          offlineCount={offlineCount}
```

The `onlineCount`/`offlineCount` consts (lines 43-44) stay — `DashboardHeader` still consumes them via `searchProps`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/integration/Dashboard.test.tsx`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/AgentSection.tsx web/src/components/DashboardMainView.tsx \
  web/src/components/__tests__/integration/Dashboard.test.tsx
git commit -m "feat: mobile agent strip replaces collapse summary bar

Always-visible horizontally scrollable agent cards below md (#452); the
collapsible summary bar is gone and the md+ responsive grid is unchanged.
Online/offline counts remain in the header search filter chips."
```

---

### Task 2: Compact icon-only session action buttons (TDD)

**Files:**
- Test: `web/src/components/__tests__/integration/SessionList.test.tsx` (add block)
- Modify: `web/src/components/SessionList.tsx` (imports + `SessionRow` action buttons)

- [ ] **Step 1: Write the failing tests**

Append this block to `web/src/components/__tests__/integration/SessionList.test.tsx` (after the closing of the outer `describe('SessionList', ...)` — i.e. before its final `});`):

```tsx
  describe('compact action buttons on mobile', () => {
    it('keeps buttons compact — no flex-1 stretch, square 44px touch targets', () => {
      render(
        <SessionList
          sessions={[makeSession()]}
          loading={false}
          onAttach={vi.fn()}
          onKill={vi.fn()}
          {...defaultProps}
        />,
      );

      for (const name of ['Attach', 'Preview scrollback', 'Kill']) {
        const btn = screen.getByRole('button', { name });
        expect(btn.className).not.toContain('flex-1');
        expect(btn.className).toContain('min-h-11');
        expect(btn.className).toContain('min-w-11');
        expect(btn.className).toContain('md:min-h-7');
      }
    });

    it('hides the text label below md so mobile buttons are icon-only', () => {
      render(
        <SessionList
          sessions={[makeSession()]}
          loading={false}
          onAttach={vi.fn()}
          onKill={vi.fn()}
          {...defaultProps}
        />,
      );

      const attach = screen.getByRole('button', { name: 'Attach' });
      const label = attach.querySelector('span');
      expect(label).toBeTruthy();
      expect(label?.className).toContain('hidden');
      expect(label?.className).toContain('md:inline');
    });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd web && npx vitest run src/components/__tests__/integration/SessionList.test.tsx`
Expected: FAIL — first test: `expect(btn.className).not.toContain('flex-1')` hits the current `flex-1 md:flex-none` class; second test: no `span` label inside Attach (or `min-h-11` assertions fail — current class is `min-h-11 md:min-h-7` so the second test may be the one that fails first).

- [ ] **Step 3: Implement compact buttons in SessionRow**

In `web/src/components/SessionList.tsx`:

1. Update the lucide import (line 1) to:

```tsx
import { ArrowUp, ArrowDown, SearchX, Eye, ArrowUpRight, Trash2 } from 'lucide-react';
```

2. Replace the action buttons `<div className="flex gap-1.5 flex-shrink-0 whitespace-nowrap">...</div>` block (lines 83-136) with:

```tsx
      <div className="flex gap-1.5 flex-shrink-0 whitespace-nowrap">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                onClick={() => onAttach(session)}
                aria-label="Attach"
                className="min-h-11 min-w-11 md:min-h-7 md:min-w-0"
              >
                <ArrowUpRight className="h-4 w-4 md:hidden" />
                <span className="hidden md:inline">Attach</span>
              </Button>
            }
          >
            Attach to session
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Attach to session</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPreview(session)}
                aria-label="Preview scrollback"
                className="min-h-11 min-w-11 md:min-h-7 md:min-w-0"
              >
                <Eye className="h-4 w-4" />
                <span className="hidden md:inline">Preview</span>
              </Button>
            }
          >
            Preview scrollback
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Preview scrollback</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                onClick={() => onKill(session)}
                aria-label="Kill"
                className="min-h-11 min-w-11 md:min-h-7 md:min-w-0 text-destructive border-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4 md:hidden" />
                <span className="hidden md:inline">Kill</span>
              </Button>
            }
          >
            Kill session
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Kill session</p>
          </TooltipContent>
        </Tooltip>
      </div>
```

Behavior notes: below `md` each button is a 44×44 icon-only square (icon hidden from a11y tree? No — icon is `md:hidden`, text is `hidden md:inline`, `aria-label` gives the stable accessible name on every viewport). From `md` up the buttons look as today (Attach text, Preview icon, Kill text) with the same `min-h-7`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/components/__tests__/integration/SessionList.test.tsx`
Expected: all pass (existing name-based queries resolve via `aria-label`).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SessionList.tsx web/src/components/__tests__/integration/SessionList.test.tsx
git commit -m "feat: compact icon-only session actions on mobile

Below md the Attach/Preview/Kill buttons no longer stretch flex-1 across the
row: 44px square touch targets with icons and aria-labels; md+ keeps today's
text buttons (#452)."
```

---

### Task 3: Quality gates

**Files:** none (verification only)

- [ ] **Step 1: Full web test suite**

Run: `cd web && npm test`
Expected: all pass, 0 failures.

- [ ] **Step 2: Web coverage**

Run: `cd web && npm run coverage` (or `just web-coverage` from repo root)
Expected: above thresholds (lines 78%, functions 72%, statements 76%, branches 65%) — pre-push gate.

- [ ] **Step 3: TypeScript + lint + build**

Run: `cd web && npx tsc --noEmit && npm run lint && npm run build`
Expected: 0 tsc errors, 0 lint warnings, build succeeds.

- [ ] **Step 4: Sanity — no Rust files changed**

Run: `git status --short`
Expected: only `web/` files and this plan doc modified — no commit needed for this step.

---

### Task 4: Playwright functional verification + screenshots

**Files:** none (verification only)

- [ ] **Step 1: Start the local stack (isolated HOME)**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &   # :19090 ws, :10080 http
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &  # :19091, needs tmux
cd web && npm run dev &                                  # :13000
```

- [ ] **Step 2: Login and create test data**

Use Playwright MCP: navigate to `http://localhost:13000`, `localStorage.clear()` first, log in with any non-empty token. Create one or two tmux sessions via the Create dialog so session rows exist.

- [ ] **Step 3: Verify mobile (375px)**

`browser_resize` to 375×812, then:
- [ ] No `agent-summary-bar` element; `agent-strip` present with agent cards
- [ ] Strip scrolls horizontally (scroll position changes when swiping / `scrollLeft` set)
- [ ] Session rows show 3 compact icon-only buttons (Attach arrow, Preview eye, Kill trash) — no full-width stretch
- [ ] `browser_console_messages` — no errors/warnings

Screenshot: `.playwright-mcp/screenshots/mobile-agent-strip.png`, `.playwright-mcp/screenshots/mobile-session-actions.png`

- [ ] **Step 4: Verify tablet/desktop (768px and 1280px)**

`browser_resize` to 1280×800:
- [ ] Agent grid renders (no strip), 3-4 columns
- [ ] Session buttons show text labels, `min-h-7` height, not stretched
- [ ] Take `.playwright-mcp/screenshots/desktop-dashboard.png` (after state)

Screenshot of the pre-change state (optional): if desired, `git stash` the two component files, screenshot at 375px, `git stash pop`. Otherwise the plan records mobile before/after via the issue's described behavior.

- [ ] **Step 5: Cleanup stack**

`pkill -f 'target/debug/nession-(server|agent)'` and `pkill -f vite`.

---

### Task 5: Push branch + PR to staging

**Files:** none

- [ ] **Step 1: Push and create PR**

```bash
git push -u origin feat/mobile-agent-strip
gh pr create --base staging --title "feat: mobile agent strip + compact session actions" --body "$(cat <<'BODY'
## 变更内容
- AgentSection: mobile 折叠摘要栏改为常驻横向滚动 agent strip（swipe 浏览，#452）
- SessionList: 移动端 Attach/Preview/Kill 改为紧凑 icon-only 按钮（44px 触控目标，aria-label），不再 flex-1 撑满整行
- 桌面 md+ 布局不变（agent 网格、文字按钮）；online/offline 计数保留在头部搜索过滤 chips

## 测试报告
- `npm test`: N passed, 0 failed
- `just web-coverage`: above thresholds (lines 78 / functions 72 / statements 76 / branches 65)
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 warnings
- `npm run build`: success
BODY
)"
```

- [ ] **Step 2: Post screenshots as a PR comment**

```bash
gh pr comment <PR-NUMBER> --body "## 截图
![mobile-agent-strip](.playwright-mcp/screenshots/mobile-agent-strip.png)
![mobile-session-actions](.playwright-mcp/screenshots/mobile-session-actions.png)
![desktop](.playwright-mcp/screenshots/desktop-dashboard.png)"
```

- [ ] **Step 3: Auto-merge to staging**

```bash
gh pr merge <PR-NUMBER> --auto --merge
```

- [ ] **Step 4: Release the claim after merge**

```bash
gh issue edit 452 --repo BestNathan/nession --remove-label in-progress
```

---

## Self-Review

**Spec coverage:**
- Goal 1 (strip replaces collapse): Task 1 ✅ — summary bar removed, `agent-strip` always visible below md.
- Goal 2 (compact icon-only buttons): Task 2 ✅ — no `flex-1`, 44px squares, icons + aria-labels.
- Goal 3 (preserve behavior): Task 1 keeps `AgentCard` tap/rename/delete/create flows via same handlers; desktop grid untouched; Task 2 desktop buttons unchanged (`md:min-h-7`, text). Search/filter: `filteredAgents` drives both strip and grid ✅.
- Success criterion 2 (bounded vertical space): strip height = card intrinsic height, no vertical growth, `overflow-x-auto` only on x-axis ✅.
- SessionsSection Create button (scope item): reviewed — already `min-h-11 md:min-h-7`, sits in header flex, not full-width; no change ✅.
- Tests (criterion 7): Tasks 1-2 ✅. Playwright (criterion 8): Task 4 ✅.
- Edge cases: 0 agents / search-empty → existing `<p>` states now visible on mobile (were hidden when collapsed) ✅; 1 agent → single card, no scroll chrome ✅; long names → `truncate` on card title, `w-64` fixed strip width ✅; ~320px phone → 44px squares × 3 + row layout fits ✅.

**Placeholder scan:** no TBD/TODO; every code step has full file content.

**Type consistency:** `AgentSection` props drop `onlineCount`/`offlineCount` in both the component and the call site; `makeAgent`/`makeSession` helpers match existing test shapes; `aria-label`s ("Attach", "Preview scrollback", "Kill") match existing `getByRole` name queries and tooltip copy.

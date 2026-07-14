# WebUI Responsive Layout Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Nession WebUI fully responsive across mobile (<768px), tablet (768–1023px), and desktop (≥1024px) with zero desktop regression, per issue #44.

**Architecture:** Mobile-first Tailwind — base utilities target phones, `md:` overrides for tablet, `lg:` pins desktop to a direct copy of today's classes. Foundational changes: `100dvh` viewport + `env(safe-area-inset-*)`. The terminal font strategy (`DeviceProfile`/`ViewportManager`) already shipped in PR #49 and is verified/tuned, not rewritten.

**Tech Stack:** React 18, TypeScript, Tailwind v4, shadcn/ui (@base-ui/react), sonner, xterm.js 5.5, Vite, Vitest + Testing Library, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-07-14-webui-responsive-layout-design.md`
**Branch:** `feat/webui-responsive-layout` (already exists, spec committed there).

---

## Conventions used throughout this plan

- **Touch targets:** we layer a `min-h-11` (44px) utility on top of the existing Button `size` variants rather than editing `button.tsx`. `min-height` and the variant's `height` don't conflict in CSS: on mobile `min-h-11` (44px) wins over `h-8` (32px); at `md:` we add `md:min-h-8` (32px = the variant height) to release back to the compact size. This keeps `ui/button.tsx` untouched (a Non-Goal forbids changing shadcn base components).
- **Class-presence tests:** Tailwind utilities don't compute layout in jsdom, so component tests assert that the right classes/elements are *present* (behavior we can verify) and Playwright verifies the actual rendered layout. Each task is explicit about which kind of check applies.
- **Run commands from `web/`** unless stated otherwise.
- **Verify not on main:** `git branch --show-current` must print `feat/webui-responsive-layout` before any commit.

---

## File Structure

**Create:**
- `web/src/hooks/useMediaQuery.ts` — reusable `matchMedia` React hook (drives responsive Toaster position).
- `web/src/hooks/__tests__/useMediaQuery.test.ts` — hook unit tests.

**Modify:**
- `web/index.html` — add `viewport-fit=cover`.
- `web/src/index.css` — `100dvh` on root; safe-area handled at call sites.
- `web/src/main.tsx` — responsive Toaster position.
- `web/src/components/SearchBar.tsx` — stacked/scrollable filter row on mobile.
- `web/src/components/Dashboard.tsx` — `dvh`, responsive padding, max-width, header icon-only Env button, collapsible AgentSection, grid breakpoints.
- `web/src/components/SessionList.tsx` — `flex-1` fill, hidden Activity col on mobile, stacked action buttons.
- `web/src/components/ui/dialog.tsx` — `max-h`/scroll on content.
- `web/src/components/ui/sheet.tsx` — full-width on mobile.
- `web/src/components/AgentDetailPanel.tsx` — safe-area padding.
- `web/src/components/TerminalView.tsx` — `dvh`, BottomBar safe-area.
- `web/src/components/TerminalToolbar.tsx` — 44px touch targets on mobile.
- `web/src/components/LoginPage.tsx` — `dvh`, drop Features card on mobile.
- Test files alongside the components above.

**Verify-only (may tune constants):**
- `web/src/terminal/DeviceProfile.ts`, `web/src/terminal/ViewportManager.ts` — tune font constants only if cols×rows targets are missed.

---

## Task 1: Foundational CSS — dvh viewport + safe-area opt-in

**Files:**
- Modify: `web/index.html:6`
- Modify: `web/src/index.css:132-136`

- [ ] **Step 1: Add `viewport-fit=cover` to the viewport meta**

In `web/index.html` line 6, replace:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
```
with:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```
(`viewport-fit=cover` is required for `env(safe-area-inset-*)` to report non-zero values on iOS.)

- [ ] **Step 2: Switch the root height to dvh**

In `web/src/index.css`, replace the block at lines 132-136:
```css
html, body, #root {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
```
with:
```css
html, body, #root {
  height: 100dvh;
  margin: 0;
  overflow: hidden;
}
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: build succeeds, no CSS errors.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/src/index.css
git commit -m "feat(web): dvh root height + viewport-fit=cover for safe-area

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Reusable `useMediaQuery` hook

**Files:**
- Create: `web/src/hooks/useMediaQuery.ts`
- Test: `web/src/hooks/__tests__/useMediaQuery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/hooks/__tests__/useMediaQuery.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '../useMediaQuery';

type Listener = (e: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean) {
  let listener: Listener | null = null;
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_: string, cb: Listener) => { listener = cb; },
    removeEventListener: () => { listener = null; },
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    emit: (matches: boolean) => {
      mql.matches = matches;
      listener?.({ matches });
    },
  };
}

describe('useMediaQuery', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('returns the initial match state', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(true);
  });

  it('updates when the media query changes', () => {
    const { emit } = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'));
    expect(result.current).toBe(false);
    act(() => emit(true));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- useMediaQuery`
Expected: FAIL — cannot resolve `../useMediaQuery`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/hooks/useMediaQuery.ts`:
```ts
import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns whether it currently matches,
 * re-rendering when it changes. SSR/no-matchMedia safe (returns false).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) { return false; }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) { return; }
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- useMediaQuery`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useMediaQuery.ts web/src/hooks/__tests__/useMediaQuery.test.ts
git commit -m "feat(web): add useMediaQuery hook

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Responsive Toaster position

**Files:**
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Extract an App wrapper that positions the Toaster responsively**

Replace the entire contents of `web/src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
import App from './App.tsx'
import './index.css'
import { useMediaQuery } from './hooks/useMediaQuery'

function Root() {
  // Mobile browser bottom bar + terminal BottomBar sheet can cover a
  // bottom-right toast; move toasts to top-center on small screens.
  const isMobile = useMediaQuery('(max-width: 767px)')
  return (
    <>
      <App />
      <Toaster position={isMobile ? 'top-center' : 'bottom-right'} richColors />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
```

- [ ] **Step 2: Verify typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/main.tsx
git commit -m "feat(web): responsive Toaster position (top-center on mobile)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: SearchBar — stacked, scrollable filter row on mobile

**Files:**
- Modify: `web/src/components/SearchBar.tsx:71-104`
- Test: `web/src/components/__tests__/SearchBar.test.tsx`

- [ ] **Step 1: Add a failing test for the responsive structure**

Append this test inside the existing `describe('SearchBar', ...)` block in `web/src/components/__tests__/SearchBar.test.tsx`:
```tsx
  it('wraps the filter buttons in a horizontally scrollable container on mobile', () => {
    const { container } = render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={1}
        offlineCount={2}
      />,
    );
    // The filter row opts into horizontal scroll so 3 buttons never overflow
    // the viewport at 320px. It collapses back to inline at sm:.
    const scroller = container.querySelector('[data-testid="filter-row"]');
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain('overflow-x-auto');
  });

  it('gives filter buttons a 44px touch target on mobile', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={1}
        offlineCount={2}
      />,
    );
    const all = screen.getByRole('button', { name: /All/ });
    expect(all.className).toContain('min-h-11');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- SearchBar`
Expected: FAIL — no element with `data-testid="filter-row"` / no `min-h-11`.

- [ ] **Step 3: Implement the responsive layout**

In `web/src/components/SearchBar.tsx`, replace the `return (...)` block (lines 71-104) with:
```tsx
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search agents and sessions..."
          value={localValue}
          onChange={handleChange}
          className="pl-8"
        />
      </div>
      <div
        data-testid="filter-row"
        className="flex items-center gap-1 overflow-x-auto flex-nowrap sm:overflow-x-visible"
      >
        {FILTERS.map((filter) => {
          const count = countForFilter(filter);
          const isActive = statusFilter === filter.key;
          return (
            <Button
              key={filter.key}
              variant={isActive ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(filter.key)}
              aria-pressed={isActive}
              className="min-h-11 sm:min-h-7 flex-shrink-0"
            >
              {filter.label}
              {count !== undefined && (
                <span className="ml-1 rounded-full bg-background/20 px-1.5 py-0.5 text-xs">
                  {count}
                </span>
              )}
            </Button>
          );
        })}
      </div>
    </div>
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- SearchBar`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SearchBar.tsx web/src/components/__tests__/SearchBar.test.tsx
git commit -m "feat(web): responsive SearchBar — stacked scrollable filters on mobile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: SessionList — flex-fill, hidden Activity col, stacked actions

**Files:**
- Modify: `web/src/components/SessionList.tsx:59-118`
- Test: `web/src/components/__tests__/SessionList.test.tsx`

- [ ] **Step 1: Add failing tests for the responsive structure**

Append inside the existing `describe('SessionList', ...)` block in `web/src/components/__tests__/SessionList.test.tsx`. First check the file's existing imports include `render`, `screen`; if a sample session factory exists reuse it, otherwise use this inline session:
```tsx
  const sampleSession = {
    session_id: 's1',
    session_name: 'build',
    agent_id: 'agent-1',
    status: 'active' as const,
    window_count: 2,
    attached_clients: 1,
    last_activity: new Date().toISOString(),
  };

  it('fills available height instead of a fixed max-height', () => {
    const { container } = render(
      <SessionList
        sessions={[sampleSession]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );
    const scrollArea = container.querySelector('[data-testid="session-scroll"]');
    expect(scrollArea?.className).toContain('flex-1');
    expect(scrollArea?.className).not.toContain('max-h-64');
  });

  it('hides the Activity sort column on mobile', () => {
    render(
      <SessionList
        sessions={[sampleSession]}
        loading={false}
        onAttach={vi.fn()}
        onKill={vi.fn()}
        attachingInProgress={false}
        sortField="name"
        sortDirection="asc"
        toggleSort={vi.fn()}
        isSearchActive={false}
      />,
    );
    const activity = screen.getByRole('button', { name: /Activity/ });
    expect(activity.className).toContain('hidden');
    expect(activity.className).toContain('md:flex');
  });
```
(If `SessionList.test.tsx` already imports `vi`/`render`/`screen`, don't re-import. The `sampleSession` fields match `Session` in `web/src/types.ts` exactly: `session_id`, `agent_id`, `session_name`, `status`, `window_count`, `attached_clients`, `last_activity`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- SessionList`
Expected: FAIL — `flex-1` not found / Activity button lacks `hidden`.

- [ ] **Step 3: Implement the responsive list**

In `web/src/components/SessionList.tsx`, replace the `return ( <ScrollArea ...> ... </ScrollArea> )` block (lines 59-118) with:
```tsx
  return (
    <ScrollArea data-testid="session-scroll" className="flex-1 min-h-0 rounded-md border">
      <div>
        {/* Sortable header row */}
        <div className="flex items-center gap-3 py-2 px-3 bg-muted/50 text-xs font-medium text-muted-foreground">
          <span className="w-2 flex-shrink-0" />
          <button className="flex-1 flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('name')}>
            Name {sortField === 'name' && (sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
          <button
            className="hidden md:flex w-16 items-center gap-1 hover:text-foreground"
            onClick={() => toggleSort('activity')}
          >
            Activity {sortField === 'activity' && (sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
          <span className="hidden md:block w-[124px] flex-shrink-0" />
        </div>
        <div className="divide-y divide-border">
          {sessions.map((session) => (
            <div
              key={session.session_id}
              className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 py-2.5 px-3 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span
                  className={cn(
                    'w-2 h-2 rounded-full flex-shrink-0',
                    session.status === 'active' ? 'bg-green-500' :
                    session.status === 'detached' ? 'bg-emerald-500/60' :
                    'bg-gray-400',
                  )}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{session.session_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {session.agent_id} · {session.window_count} win · {session.attached_clients} client
                    {session.attached_clients !== 1 ? 's' : ''}
                    {session.status === 'detached' && ' · detached'}
                    {session.status === 'zombie' && ' · zombie'}
                  </p>
                </div>
              </div>
              <div className="flex gap-1.5 flex-shrink-0">
                <Button
                  size="sm"
                  onClick={() => onAttach(session)}
                  disabled={attachingInProgress}
                  className="flex-1 md:flex-none min-h-11 md:min-h-7"
                >
                  Attach
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onKill(session)}
                  className="flex-1 md:flex-none min-h-11 md:min-h-7 text-destructive border-destructive hover:bg-destructive/10"
                >
                  Kill
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- SessionList`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SessionList.tsx web/src/components/__tests__/SessionList.test.tsx
git commit -m "feat(web): responsive SessionList — flex-fill, mobile-stacked rows, 44px actions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Dashboard — dvh, responsive padding, max-width, header, collapsible Agents, grid breakpoints

**Files:**
- Modify: `web/src/components/Dashboard.tsx` (AgentSection lines 28-63, DashboardHeader 90-108, root 234-274)
- Test: `web/src/components/__tests__/Dashboard.test.tsx` (create if absent)

- [ ] **Step 1: Update the AgentSection grid breakpoints + add collapsible mobile summary**

In `web/src/components/Dashboard.tsx`, replace the `AgentSection` function (lines 28-63) with:
```tsx
function AgentSection({
  loadingAgents,
  agents,
  filteredAgents,
  isSearchActive,
  setSelectedAgent,
  onlineCount,
  offlineCount,
}: {
  loadingAgents: boolean;
  agents: Agent[];
  filteredAgents: Agent[];
  isSearchActive: boolean;
  setSelectedAgent: (a: Agent | null) => void;
  onlineCount: number;
  offlineCount: number;
}) {
  // Mobile: Agents collapse behind a summary bar so Sessions gets the screen
  // by default. At md:+ the grid is always visible (md:grid wins) regardless
  // of `expanded`, so no viewport JS is needed.
  const [expanded, setExpanded] = useState(false);
  const gridClass = 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Agents</h2>
      </div>
      {/* Mobile-only collapse summary bar */}
      <button
        type="button"
        data-testid="agent-summary-bar"
        onClick={() => setExpanded((v) => !v)}
        className="md:hidden w-full flex items-center justify-between rounded-lg border px-3 min-h-11 mb-2 text-sm"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" /> {onlineCount} online
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-gray-400" /> {offlineCount} offline
          </span>
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {loadingAgents ? (
        <div className={cn(expanded ? 'grid' : 'hidden', 'md:grid gap-3', gridClass)}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        </div>
      ) : agents.length === 0 ? (
        <p className={cn(expanded ? 'block' : 'hidden', 'md:block text-sm text-muted-foreground py-8 text-center')}>No agents connected</p>
      ) : filteredAgents.length === 0 && isSearchActive ? (
        <p className={cn(expanded ? 'block' : 'hidden', 'md:block text-sm text-muted-foreground py-8 text-center')}>No agents match your search</p>
      ) : (
        <div className={cn(expanded ? 'grid' : 'hidden', 'md:grid gap-3', gridClass)}>
          {filteredAgents.map((a) => (
            <AgentCard key={a.agent_id} agent={a} onClick={() => setSelectedAgent(a)} />
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Add the required imports**

At the top of `web/src/components/Dashboard.tsx`, update the imports:
- Change `import { useCallback } from 'react';` (line 1) to `import { useCallback, useState } from 'react';`
- Change the lucide import (line 2) `import { Plus, RefreshCw, X, FileCog } from 'lucide-react';` to `import { Plus, RefreshCw, X, FileCog, ChevronDown, ChevronUp } from 'lucide-react';`

- [ ] **Step 3: Make the Env Files button icon-only on mobile**

In `DashboardHeader` (lines 102-104), replace:
```tsx
        <Button size="sm" variant="outline" onClick={onOpenEnv}>
          <FileCog className="w-4 h-4 mr-1" /> Env Files
        </Button>
```
with:
```tsx
        <Button size="sm" variant="outline" onClick={onOpenEnv} className="min-h-11 md:min-h-7">
          <FileCog className="w-4 h-4 md:mr-1" /> <span className="hidden md:inline">Env Files</span>
        </Button>
```
And give the refresh button a mobile touch target — replace lines 105-107:
```tsx
        <Button size="sm" onClick={() => fetchSessions()} disabled={loadingAgents}>
          <RefreshCw className={cn('w-4 h-4', loadingAgents && 'animate-spin')} />
        </Button>
```
with:
```tsx
        <Button size="sm" onClick={() => fetchSessions()} disabled={loadingAgents} className="min-h-11 min-w-11 md:min-h-7 md:min-w-0">
          <RefreshCw className={cn('w-4 h-4', loadingAgents && 'animate-spin')} />
        </Button>
```

- [ ] **Step 4: Update the root container + pass counts into AgentSection**

In the `Dashboard` component, replace the root div opening (line 235):
```tsx
    <div className="h-screen flex flex-col bg-background">
```
with:
```tsx
    <div className="h-[100dvh] flex flex-col bg-background">
```
Replace the content wrapper (line 250):
```tsx
      <div className="flex-1 min-h-0 flex flex-col p-6 gap-6">
```
with:
```tsx
      <div className="flex-1 min-h-0 flex flex-col p-3 gap-4 md:p-4 lg:p-6 lg:gap-6 pb-[env(safe-area-inset-bottom)] w-full max-w-[1920px] mx-auto">
```
Replace the `<AgentSection ... />` usage (lines 251-257) to pass counts:
```tsx
        <AgentSection
          loadingAgents={loadingAgents}
          agents={agents}
          filteredAgents={filteredAgents}
          isSearchActive={isSearchActive}
          setSelectedAgent={setSelectedAgent}
          onlineCount={onlineCount}
          offlineCount={offlineCount}
        />
```
(`onlineCount`/`offlineCount` are already computed at lines 221-222.)

- [ ] **Step 5: Add a component test for the collapse toggle**

Create (or append to) `web/src/components/__tests__/Dashboard.test.tsx`. If the file doesn't exist, create it with a focused test of `AgentSection` via the exported `Dashboard` is heavy (needs wsService); instead export `AgentSection` for testing OR test through DOM. Simplest: add `export` to `AgentSection` and test it directly.

First, in `Dashboard.tsx`, change `function AgentSection(` to `export function AgentSection(`.

Then create `web/src/components/__tests__/Dashboard.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentSection } from '../Dashboard';

describe('AgentSection (mobile collapse)', () => {
  const baseProps = {
    loadingAgents: false,
    agents: [],
    filteredAgents: [],
    isSearchActive: false,
    setSelectedAgent: vi.fn(),
    onlineCount: 3,
    offlineCount: 1,
  };

  it('renders a summary bar with online/offline counts', () => {
    render(<AgentSection {...baseProps} />);
    const bar = screen.getByTestId('agent-summary-bar');
    expect(bar).toHaveTextContent('3 online');
    expect(bar).toHaveTextContent('1 offline');
    expect(bar).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles aria-expanded when the summary bar is tapped', () => {
    render(<AgentSection {...baseProps} />);
    const bar = screen.getByTestId('agent-summary-bar');
    fireEvent.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'false');
  });
});
```

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `npm test -- Dashboard && npx tsc --noEmit && npm run lint`
Expected: tests PASS, no type errors, 0 lint warnings.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Dashboard.tsx web/src/components/__tests__/Dashboard.test.tsx
git commit -m "feat(web): responsive Dashboard — dvh, collapsible Agents, grid breakpoints, touch targets

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Dialog — scrollable tall content + dialog touch targets

**Files:**
- Modify: `web/src/components/ui/dialog.tsx:53-56`

- [ ] **Step 1: Add max-height + scroll to DialogContent**

In `web/src/components/ui/dialog.tsx`, the `DialogContent` className (lines 53-56) currently ends with `...data-closed:zoom-out-95`. Append `max-h-[calc(100dvh-2rem)] overflow-y-auto` to that className string. Replace:
```tsx
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
```
with:
```tsx
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
```
(The footer already stacks on mobile via `flex-col-reverse ... sm:flex-row` at line 103 — no change needed.)

- [ ] **Step 2: Verify existing dialog tests still pass**

Run: `npm test -- CreateSessionDialog KillConfirmDialog`
Expected: PASS (no behavior change; class-only edit).

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ui/dialog.tsx
git commit -m "feat(web): dialog content scrolls when taller than viewport on mobile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Sheet — full width on mobile + AgentDetailPanel safe-area

**Files:**
- Modify: `web/src/components/ui/sheet.tsx:53-55`
- Modify: `web/src/components/AgentDetailPanel.tsx` (SheetContent usage)

- [ ] **Step 1: Make left/right sheets full-width on mobile**

In `web/src/components/ui/sheet.tsx`, within the `SheetContent` className (lines 53-55), the two occurrences currently read `data-[side=left]:w-3/4` and `data-[side=right]:w-3/4`, with `data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm` at the end. Change the two width classes to be full-width by default and 3/4 at `sm:`. Replace `data-[side=left]:w-3/4` with `data-[side=left]:w-full data-[side=left]:sm:w-3/4` and `data-[side=right]:w-3/4` with `data-[side=right]:w-full data-[side=right]:sm:w-3/4`.

Concretely, find these substrings in the long className and edit in place:
- `data-[side=left]:h-full data-[side=left]:w-3/4` → `data-[side=left]:h-full data-[side=left]:w-full data-[side=left]:sm:w-3/4`
- `data-[side=right]:h-full data-[side=right]:w-3/4` → `data-[side=right]:h-full data-[side=right]:w-full data-[side=right]:sm:w-3/4`

(The trailing `data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm` stays — it caps width at `sm:`+.)

- [ ] **Step 2: Fix the AgentDetailPanel's own width (it overrides the sheet default)**

`AgentDetailPanel.tsx:77` passes its own width, which overrides the sheet default and is a fixed `400px` that **overflows a 375px screen**:
```tsx
      <SheetContent side="right" className="w-[400px] sm:w-[480px] overflow-y-auto">
```
Replace with full-width on mobile + safe-area padding:
```tsx
      <SheetContent side="right" className="w-full sm:w-[480px] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
```
(Because this component sets its own `w-*`, the Step 1 default change won't reach it — this explicit fix is what makes the panel full-width on mobile per spec §3.7. The Step 1 change still hardens any future Sheet consumer.)

- [ ] **Step 3: Verify AgentDetailPanel tests pass**

Run: `npm test -- AgentDetailPanel`
Expected: PASS.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui/sheet.tsx web/src/components/AgentDetailPanel.tsx
git commit -m "feat(web): full-width Sheet on mobile + safe-area padding

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: TerminalView — dvh + BottomBar safe-area

**Files:**
- Modify: `web/src/components/TerminalView.tsx:105` and BottomBar container line 199

- [ ] **Step 1: Switch TerminalView root to dvh**

In `web/src/components/TerminalView.tsx`, replace line 105:
```tsx
    <div className="h-screen flex flex-col bg-background">
```
with:
```tsx
    <div className="h-[100dvh] flex flex-col bg-background">
```

- [ ] **Step 2: Add safe-area padding to the BottomBar**

In the `BottomBar` function, replace the outer container (line 199):
```tsx
    <div className="border-t flex-shrink-0 flex flex-col max-h-[70vh] sm:max-h-[40vh]">
```
with:
```tsx
    <div className="border-t flex-shrink-0 flex flex-col max-h-[70dvh] sm:max-h-[40dvh] pb-[env(safe-area-inset-bottom)]">
```
(Also switches the max-height from `vh` to `dvh` for consistency with the mobile address bar.)

- [ ] **Step 3: Verify terminal-related tests pass**

Run: `npm test -- Terminal`
Expected: PASS (Terminal.p2pGate, Terminal.reconnect unaffected — class-only edits).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TerminalView.tsx
git commit -m "feat(web): TerminalView dvh + BottomBar safe-area padding

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: TerminalToolbar — 44px touch targets on mobile

**Files:**
- Modify: `web/src/components/TerminalToolbar.tsx:58-114`
- Test: `web/src/components/__tests__/TerminalToolbar.test.tsx`

- [ ] **Step 1: Add a failing test for mobile touch sizing**

Append inside the existing `describe` block in `web/src/components/__tests__/TerminalToolbar.test.tsx`:
```tsx
  it('gives preset command buttons a 44px touch target on mobile', () => {
    render(<TerminalToolbar sendText={vi.fn()} />);
    // PRESETS render as buttons; the first preset should carry the mobile
    // touch-target class that releases at md:.
    const buttons = screen.getAllByRole('button');
    const preset = buttons.find((b) => b.className.includes('h-11 md:h-6'));
    expect(preset).toBeDefined();
  });
```
(If `TerminalToolbar.test.tsx` lacks imports for `render`/`screen`/`vi`, add them: `import { render, screen } from '@testing-library/react'; import { describe, it, expect, vi } from 'vitest';`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- TerminalToolbar`
Expected: FAIL — no button with `h-11 md:h-6`.

- [ ] **Step 3: Bump the touch targets**

In `web/src/components/TerminalToolbar.tsx`, apply these class changes (mobile-first `h-11`, release to compact at `md:`):

Preset buttons (line 60-62):
```tsx
        {PRESETS.map((cmd) => (
          <Button key={cmd.id} variant="outline" size="sm"
            className="h-11 md:h-6 text-xs md:text-[11px] px-2" disabled={disabled}
            onClick={() => runCommand(cmd)}>{cmd.label}</Button>
        ))}
```
User command button + delete (lines 64-72):
```tsx
        {userCommands.map((cmd) => (
          <div key={cmd.id} className="flex items-center h-11 md:h-6">
            <Button variant="outline" size="sm"
              className="h-11 md:h-6 text-xs md:text-[11px] px-2 rounded-r-none" disabled={disabled}
              onClick={() => runCommand(cmd)}>{cmd.label}</Button>
            <Button variant="ghost" size="icon" className="h-11 md:h-6 w-9 md:w-5 rounded-l-none"
              disabled={disabled} onClick={() => deleteUserCommand(cmd.id)} title="Delete">
              <X className="h-3 w-3" /></Button>
          </div>
        ))}
```
Add button (lines 88-90):
```tsx
          <Button variant="ghost" size="sm" className="h-11 md:h-6 text-xs md:text-[11px] px-2"
            disabled={disabled} onClick={() => setShowAddForm(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add</Button>
```
Send button (lines 110-113):
```tsx
        <Button variant="outline" size="icon" className="h-11 w-11 md:h-7 md:w-7 flex-shrink-0" title="Send"
          onClick={sendInput} disabled={disabled}>
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- TerminalToolbar`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/TerminalToolbar.tsx web/src/components/__tests__/TerminalToolbar.test.tsx
git commit -m "feat(web): 44px touch targets in TerminalToolbar on mobile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: LoginPage — dvh + drop Features card on mobile

**Files:**
- Modify: `web/src/components/LoginPage.tsx:68,124`
- Test: `web/src/components/__tests__/LoginPage.test.tsx`

- [ ] **Step 1: Add a failing test that the Features card is mobile-hidden**

Append inside the existing `describe` block in `web/src/components/__tests__/LoginPage.test.tsx`:
```tsx
  it('hides the Features card on mobile (md:block)', () => {
    const { container } = render(
      <LoginPage
        connectionStatus="disconnected"
        serverUrl=""
        setServerUrl={vi.fn()}
        authToken=""
        setAuthToken={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    const featuresCard = container.querySelector('[data-testid="features-card"]');
    expect(featuresCard).not.toBeNull();
    expect(featuresCard?.className).toContain('hidden');
    expect(featuresCard?.className).toContain('md:block');
  });
```
(Match the existing test file's import style / prop values.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- LoginPage`
Expected: FAIL — no `data-testid="features-card"`.

- [ ] **Step 3: Implement dvh + hide Features card**

In `web/src/components/LoginPage.tsx`, replace line 68:
```tsx
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
```
with:
```tsx
    <div className="min-h-[100dvh] flex flex-col items-center justify-center p-4">
```
Replace the Features `<Card>` opening (line 124):
```tsx
      <Card className="w-full max-w-md">
```
with:
```tsx
      <Card data-testid="features-card" className="hidden md:block w-full max-w-md">
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- LoginPage`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/LoginPage.tsx web/src/components/__tests__/LoginPage.test.tsx
git commit -m "feat(web): LoginPage dvh + hide Features card on mobile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Full test + build gate

**Files:** none (verification only)

- [ ] **Step 1: Run the complete web test suite with coverage**

Run: `npm test -- --run && npm run coverage`
Expected: all tests PASS; coverage ≥80% (project threshold).

- [ ] **Step 2: Full lint + typecheck + build**

Run: `npm run lint && npx tsc --noEmit && npm run build`
Expected: 0 lint warnings, no type errors, build succeeds.

- [ ] **Step 3: If any gate fails, fix and re-run before proceeding.**

No commit (verification task). If fixes were needed, commit them with a `fix:` message.

---

## Task 13: Playwright visual verification + acceptance checks

**Files:** screenshots saved to `.playwright-mcp/screenshots/` (gitignored).

Run the local demo stack per CLAUDE.md (isolated HOME):
```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev &
```
Log in at `http://localhost:13000` with any non-empty token (run `localStorage.clear()` first). Create at least one session so SessionList + TerminalView have content.

- [ ] **Step 1: Capture desktop baseline (regression guard, Success Criterion #7)**

Before verifying, checkout `main` in a scratch worktree OR rely on pre-refactor screenshots if already captured. Using Playwright MCP at **1440px**, screenshot LoginPage, Dashboard, TerminalView from `main`. Save as `.playwright-mcp/screenshots/baseline-1440-*.png`. (If baselines were not captured pre-refactor, note this in the PR and rely on visual review of the after-shots.)

- [ ] **Step 2: Capture all surfaces at 4 viewports**

For each width **375, 768, 1024, 1440**: use `mcp__playwright__browser_resize`, then `mcp__playwright__browser_navigate` / interact and `mcp__playwright__browser_take_screenshot` for: LoginPage, Dashboard (on 375: Agents collapsed AND expanded), SessionList, AgentDetailPanel (open the Sheet), CreateSessionDialog (open it), KillConfirmDialog (open it), TerminalView (chrome + collapsed BottomBar). Save to `.playwright-mcp/screenshots/<surface>-<width>.png`.

- [ ] **Step 3: Assert no horizontal overflow (Success Criterion #1)**

At 320 and 375px, run via `mcp__playwright__browser_evaluate`:
```js
() => {
  const el = document.scrollingElement;
  return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflow: el.scrollWidth > el.clientWidth };
}
```
Expected: `overflow === false` on every page.

- [ ] **Step 4: Measure touch targets (Success Criterion #2)**

At 375px, evaluate bounding boxes of key buttons (SearchBar filters, SessionList Attach/Kill, TerminalToolbar presets/send, Dashboard header buttons). Expected: every interactive element's rendered height ≥ 44px. Record any that fail and fix the corresponding `min-h-11` class.

- [ ] **Step 5: Measure terminal cols×rows (Success Criteria #4, #9)**

With a session attached, at 375px and 1440px, read the terminal dimensions. The xterm instance renders into `.xterm-screen`; measure via the terminal handle if exposed, or read the DOM rows/cols. Evaluate:
```js
() => {
  const rows = document.querySelectorAll('.xterm-rows > div').length;
  // cols: read from the renderer via the DOM measurement helper if available,
  // otherwise infer from .xterm-screen width / cell width.
  return { rows };
}
```
Expected: 375px → cols×rows ≥ 1000; 1440px → cols×rows ≥ 5000. **If a target is missed, tune constants in `web/src/terminal/DeviceProfile.ts` (raise desktop `fontSize`/`FONT_MAX` toward 15–16, or adjust phone profile) and `ViewportManager.ts` (`FONT_MAX`), then re-run `npm test -- ViewportManager` and re-measure.** Commit any tuning as `fix(web): tune terminal font profile to hit cols×rows targets`.

- [ ] **Step 6: Verify terminal usability at 375px (Success Criterion #8)**

At 375px, type a command into the terminal (via the TerminalToolbar input or direct focus), submit, confirm output renders and history scrolls. Screenshot the result.

- [ ] **Step 7: Desktop regression review (Success Criterion #7)**

Compare the 1440px after-shots against the Step 1 baselines. Only intentional spacing changes (the `lg:p-6 lg:gap-6` values are unchanged from `p-6 gap-6`, so Dashboard padding should be identical) are acceptable. Flag any unexpected difference.

- [ ] **Step 8: Tear down the demo stack**

Run: `pkill -f 'target/debug/nession-(server|agent)'; pkill -f vite`

- [ ] **Step 9: Commit any verification-driven fixes**

If Steps 4–5 required class or constant changes, commit them now. Otherwise no commit.

---

## Task 14: Open PR

**Files:** none.

- [ ] **Step 1: Confirm branch + push**

Run: `git branch --show-current` (expect `feat/webui-responsive-layout`), then `git push -u origin feat/webui-responsive-layout`.

- [ ] **Step 2: Create the PR**

Run:
```bash
gh pr create --title "feat: WebUI responsive layout refactor (three-device)" --body "$(cat <<'EOF'
Closes #44

## 概述
将 WebUI 重构为 mobile-first 三设备响应式布局(mobile <768px / tablet md: / desktop lg:),桌面端值以 lg: 直接复刻,零退化。

## 变更
- dvh 视口 + `env(safe-area-inset-*)`(iOS 安全区)
- Dashboard:折叠式 Agents 摘要栏(移动端)、响应式 grid(1/2-3/4 列)、响应式内边距 + max-w-[1920px]
- SessionList:flex 填充替代 max-h-64、移动端隐藏 Activity 列、操作按钮堆叠 + 44px 触摸目标
- SearchBar:移动端筛选按钮横向滚动 + 44px
- Dialog:超高内容滚动;Sheet:移动端全宽
- TerminalView/TerminalToolbar:dvh、安全区、44px 触摸目标
- LoginPage:移动端隐藏 Features 卡
- Toaster:移动端 top-center
- Terminal 字号策略(PR #49 已交付)验证达标:移动端 cols×rows ≥1000,桌面 ≥5000

## 核心功能截图
(附 375/768/1024/1440 四视口截图 — .playwright-mcp/screenshots/)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2b: Attach screenshots** to the PR body/comment (drag the `.playwright-mcp/screenshots/*.png` into the PR on GitHub, or reference repo-relative paths).

---

## Self-Review Notes

Coverage check against spec §3 (all components mapped to tasks):
- §3.1 index.css → Task 1 ✅ | §3.2 Dashboard container/header → Task 6 ✅ | §3.3 AgentSection collapse → Task 6 ✅ | §3.4 SearchBar → Task 4 ✅ | §3.5 SessionList → Task 5 ✅ | §3.6 Dialog → Task 7 ✅ | §3.7 Sheet/AgentDetailPanel → Task 8 ✅ | §3.8 TerminalView → Task 9 ✅ | §3.9 TerminalToolbar → Task 10 ✅ | §3.10 Toaster → Tasks 2+3 ✅ | §3.11 LoginPage → Task 11 ✅ | §3.12 terminal font verify/tune → Task 13 Step 5 ✅
- §4 testing → Tasks 4/5/6/10/11 (unit) + 12 (gate) + 13 (Playwright) ✅
- §5 delivery (single PR, Closes #44, screenshots) → Task 14 ✅

Type/name consistency: `useMediaQuery(query: string): boolean` defined Task 2, consumed Task 3. `AgentSection` gains `onlineCount`/`offlineCount` props (Task 6 Step 1) and is exported for test (Task 6 Step 5). `data-testid` hooks: `filter-row`, `session-scroll`, `agent-summary-bar`, `features-card` — each defined in the same task that asserts on it.

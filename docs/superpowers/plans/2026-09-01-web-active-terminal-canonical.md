# Web Active Terminal Canonical Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the approved Web Active Terminal canonical screen at 1440×900 — terminal-native chrome (no global wordmark bar, hairline separators, mono session line, state-driven emphasis) on the staging session-first shell, plus a deterministic `/fixture` route that doubles as the Phase 6 golden-baseline source.

**Architecture:** Restyle the existing `web/src/session-first/` shell in place (no interaction/logic changes): delete the global chrome bar, quiet the sidebar (canvas + hairline, selection = accent bar), collapse `SessionHeader` into a mono session line, and add a fixture route rendering the **real** `SessionFirstWorkspace` with deterministic data and a real xterm seeded with static content. `SessionFirstMain` gains an optional `terminal` slot so the fixture can substitute a static terminal. Docs (`visual-language.md`, `composition.md`) are updated in the same PR to match the approved screen.

**Tech Stack:** React 18, react-router (HashRouter), Tailwind v4 + shadcn/ui, `--sf-*` + generated design tokens (no new hex), xterm.js (`@xterm/xterm` + `CATPPUCCIN_MOCHA`), Vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-01-web-active-terminal-canonical-design.md`](../specs/2026-09-01-web-active-terminal-canonical-design.md)

---

### Task 1: Deterministic fixture data module

**Files:**
- Create: `web/src/session-first/fixture/fixtureData.ts`
- Test: `web/src/session-first/fixture/__tests__/fixtureData.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/session-first/fixture/__tests__/fixtureData.test.ts
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '../fixtureData';

describe('fixtureData', () => {
  it('defines a deterministic 6-session / 3-agent matrix', () => {
    expect(FIXTURE_SESSIONS).toHaveLength(6);
    expect(FIXTURE_AGENTS).toHaveLength(3);
  });

  it('includes one offline agent to exercise state-driven emphasis', () => {
    expect(FIXTURE_AGENTS.filter((a) => a.status === 'offline')).toHaveLength(1);
  });

  it('includes an exited (zombie) session and a session on the offline agent', () => {
    expect(FIXTURE_SESSIONS.some((s) => s.status === 'zombie')).toBe(true);
    expect(FIXTURE_SESSIONS.some((s) => s.agent_id === 'sg-prod')).toBe(true);
  });

  it('selected session exists and is the attached client session', () => {
    expect(FIXTURE_SESSIONS.some((s) => s.session_id === FIXTURE_SELECTED_ID)).toBe(true);
    expect(FIXTURE_CLIENT_SESSION_ID).toBe(FIXTURE_SELECTED_ID);
  });

  it('session ids follow the agent_id:session_name convention', () => {
    for (const s of FIXTURE_SESSIONS) {
      expect(s.session_id).toBe(`${s.agent_id}:${s.session_name}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/fixture/__tests__/fixtureData.test.ts`
Expected: FAIL — `Cannot find module '../fixtureData'`

- [ ] **Step 3: Write the fixture data module**

```ts
// web/src/session-first/fixture/fixtureData.ts
import type { Agent, Session } from '@/types';

/**
 * Deterministic fixture for the canonical screen (/fixture route).
 * Static timestamps — screenshots remain comparable across runs.
 * Doubles as the Phase 6 (#561) golden-baseline data source.
 */
export const FIXTURE_AGENTS: Agent[] = [
  {
    agent_id: 'devbox-01',
    hostname: 'devbox-01',
    display_name: 'devbox-01',
    ip_address: '10.0.0.11',
    port: 19091,
    status: 'online',
    session_count: 3,
    last_heartbeat: '2026-09-01T08:00:00Z',
    registered_at: '2026-08-01T00:00:00Z',
  },
  {
    agent_id: 'macbook',
    hostname: 'macbook',
    display_name: 'macbook',
    ip_address: '10.0.0.12',
    port: 19091,
    status: 'online',
    session_count: 2,
    last_heartbeat: '2026-09-01T08:00:00Z',
    registered_at: '2026-08-15T00:00:00Z',
  },
  {
    agent_id: 'sg-prod',
    hostname: 'sg-prod',
    display_name: 'sg-prod',
    ip_address: '10.0.0.21',
    port: 19091,
    status: 'offline',
    session_count: 1,
    last_heartbeat: '2026-09-01T07:30:00Z',
    registered_at: '2026-08-20T00:00:00Z',
  },
];

export const FIXTURE_SESSIONS: Session[] = [
  {
    session_id: 'devbox-01:fix-terminal-reconnect',
    agent_id: 'devbox-01',
    session_name: 'fix-terminal-reconnect',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    last_activity: '2026-09-01T08:00:00Z',
  },
  {
    session_id: 'devbox-01:design-system',
    agent_id: 'devbox-01',
    session_name: 'design-system',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-09-01T07:40:00Z',
  },
  {
    session_id: 'devbox-01:staging-deploy',
    agent_id: 'devbox-01',
    session_name: 'staging-deploy',
    status: 'zombie',
    window_count: 0,
    attached_clients: 0,
    last_activity: '2026-09-01T03:30:00Z',
  },
  {
    session_id: 'macbook:review-pr-561',
    agent_id: 'macbook',
    session_name: 'review-pr-561',
    status: 'active',
    window_count: 2,
    attached_clients: 1,
    last_activity: '2026-09-01T07:20:00Z',
  },
  {
    session_id: 'macbook:dotfiles',
    agent_id: 'macbook',
    session_name: 'dotfiles',
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-09-01T06:10:00Z',
  },
  {
    session_id: 'sg-prod:prod-shell',
    agent_id: 'sg-prod',
    session_name: 'prod-shell',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-09-01T05:00:00Z',
  },
];

export const FIXTURE_SELECTED_ID = 'devbox-01:fix-terminal-reconnect';
export const FIXTURE_CLIENT_SESSION_ID = FIXTURE_SELECTED_ID;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/session-first/fixture/__tests__/fixtureData.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/fixture/
git commit -m "test: add deterministic fixture data for canonical screen (#561)"
```

---

### Task 2: FixtureTerminal — real xterm with seeded content

**Files:**
- Create: `web/src/session-first/fixture/FixtureTerminal.tsx`

First verify xterm CSS is already loaded globally (it should be — the shipping terminal uses it):

- [ ] **Step 1: Check xterm.css import**

Run: `grep -rn "xterm.css" web/src/ --include="*.tsx" --include="*.ts" | head -5`
Expected: an existing `import '@xterm/xterm/css/xterm.css'` somewhere (e.g. `main.tsx` or `terminal/components/TerminalPane.tsx`). If found, do **not** import it again in FixtureTerminal. If not found, add the import inside FixtureTerminal.

- [ ] **Step 2: Write FixtureTerminal**

```tsx
// web/src/session-first/fixture/FixtureTerminal.tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { CATPPUCCIN_MOCHA } from '@/terminal';

const FIXTURE_BUFFER = [
  '$ git status --short',
  ' M web/src/session-first/patterns/SessionHeader.tsx',
  ' M docs/design/visual-language.md',
  '$ cargo test -p nession-common 2>&1 | tail -3',
  'running 42 tests',
  'test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
  '',
  '$ npm run lint --workspace=web --silent',
  '✨  No lint errors found.',
  '',
  '─ sessions are terminal-first; chrome stays quiet ─',
].join('\r\n');

/**
 * Static, deterministic terminal for the canonical /fixture route.
 * Real xterm instance; no transport, no network. Phase 6 baseline source.
 */
export function FixtureTerminal() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: CATPPUCCIN_MOCHA,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    });
    term.open(ref.current as HTMLDivElement);
    term.write(FIXTURE_BUFFER);
    return () => term.dispose();
  }, []);

  return <div data-testid="fixture-terminal" ref={ref} className="h-full w-full" />;
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/session-first/fixture/FixtureTerminal.tsx
git commit -m "feat: static deterministic xterm for canonical fixture (#561)"
```

---

### Task 3: `SessionFirstMain` terminal slot + sidebar `connectionStatus` prop

**Files:**
- Modify: `web/src/session-first/SessionFirstMain.tsx`
- Modify: `web/src/session-first/SessionFirstSidebar.tsx`
- Modify: `web/src/session-first/SessionFirstWorkspace.tsx`

- [ ] **Step 1: Add the `terminal` slot to SessionFirstMain**

In `web/src/session-first/SessionFirstMain.tsx`:

```tsx
import type { ReactNode } from 'react';
// …existing imports…

export interface SessionFirstMainProps {
  // …existing props…
  showTerminal?: boolean;
  showWorkspace?: boolean;
  /** Fixture/testing override for the terminal surface. Defaults to the real attached terminal. */
  terminal?: ReactNode;
}

export function SessionFirstMain({
  // …existing destructured props…
  showTerminal = true,
  showWorkspace = true,
  terminal,
}: SessionFirstMainProps) {
  return (
    <>
      {/* …SessionHeader unchanged… */}
      <div data-testid="session-first-main-content" className="relative flex min-h-0 flex-1 flex-col gap-0">
        {showTerminal ? (
          <TerminalWell
            className={cn(
              'min-h-0',
              (surface !== 'terminal' || !selectedSession) && 'hidden',
            )}
          >
            {terminal ?? (
              <SessionFirstTerminal
                hidden={surface !== 'terminal' || !selectedSession}
                onDisconnect={() => undefined}
                onError={() => undefined}
              />
            )}
          </TerminalWell>
        ) : null}
        {/* …WorkspacePanel unchanged… */}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add `connectionStatus` to SessionFirstSidebar and its footer**

In `web/src/session-first/SessionFirstSidebar.tsx`:

```tsx
// add to imports:
import type { ConnectionStatus } from '@/types';

// add to SessionFirstSidebarProps:
  connectionStatus: ConnectionStatus;

// destructure `connectionStatus` in the function signature.

// replace the footer block (keep safe-area padding):
      <div
        data-testid="session-first-sidebar-footer"
        className="flex shrink-0 items-center justify-between gap-2 border-t px-[var(--sf-space-2)] py-[var(--sf-space-2)] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <span
          data-testid="server-connection"
          className={cn(
            'truncate font-mono text-xs',
            connectionStatus === 'disconnected'
              ? 'text-agent-error'
              : 'text-muted-foreground',
          )}
        >
          server: {connectionStatus}
        </span>
        <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />
      </div>
```

- [ ] **Step 3: Thread the prop through SessionFirstWorkspace and SessionFirstShell**

In `web/src/session-first/SessionFirstWorkspace.tsx`:
- Add `connectionStatus: ConnectionStatus;` to `SessionFirstWorkspaceProps`.
- Add `import type { ConnectionStatus } from '@/types';`
- Destructure it and include it in `sidebarProps`.

In `web/src/session-first/SessionFirstShell.tsx`:
- Pass the prop through to the workspace: add `connectionStatus={connectionStatus}` to the `<SessionFirstWorkspace … />` element (the shell already receives `connectionStatus` in its props).

- [ ] **Step 4: Verify typecheck + existing tests**

Run: `cd web && npx tsc --noEmit && npx vitest run src/__tests__/integration/App.sessionFirst.test.tsx`
Expected: 0 tsc errors; App.sessionFirst tests PASS. (They do not pass `connectionStatus` — if a test renders `SessionFirstWorkspace`/`SessionFirstSidebar` directly, add `connectionStatus="connected"` to that render; check with `grep -rn "SessionFirstSidebar\|SessionFirstWorkspace" web/src --include="*.test.tsx"`.)

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/
git commit -m "feat: terminal slot and server-connection footer for canonical shell (#561)"
```

---

### Task 4: FixtureShell + `/fixture` route + component test

**Files:**
- Create: `web/src/session-first/fixture/FixtureShell.tsx`
- Test: `web/src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx` (repo convention: vitest only picks up `src/**/__tests__/unit/**` (node env) and `src/**/__tests__/integration/**` (jsdom); component tests using @testing-library/render need the jsdom `integration` dir — plain `__tests__/fixtureData.test.ts` paths are silently ignored)
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FixtureShell } from '../FixtureShell';

vi.mock('../FixtureTerminal', () => ({
  FixtureTerminal: () => <div data-testid="fixture-terminal" />,
}));

describe('FixtureShell', () => {
  it('renders the deterministic session-first shell', () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('session-first-shell')).toBeInTheDocument();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(6);
    expect(screen.getByTestId('session-first-main-content')).toBeInTheDocument();
    expect(screen.getByTestId('fixture-terminal')).toBeInTheDocument();
  });
});
```

Note: the `data-selected` count assertion is added in Task 6 Step 3 (the attribute lands with the selection-cue restyle), and the `session-header-line` assertion in Task 7 Step 5 (the testid lands with the header restyle).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx`
Expected: FAIL — `Cannot find module '../FixtureShell'` (and `session-header-line` testid does not exist yet — both are fine at this stage).

- [ ] **Step 3: Write FixtureShell**

```tsx
// web/src/session-first/fixture/FixtureShell.tsx
import { FixtureTerminal } from '@/session-first/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/session-first/fixture/fixtureData';
import { mapDomainState } from '@/session-first/domainState';
import { SessionFirstWorkspace } from '@/session-first/SessionFirstWorkspace';

/**
 * Canonical Active Terminal screen (#561 Phase 2A): the real
 * session-first composition rendered with deterministic data and a
 * static terminal. No network, no auth. Also the Phase 6 baseline source.
 */
export function FixtureShell() {
  const selectedId = FIXTURE_SELECTED_ID;
  const selectedSession =
    FIXTURE_SESSIONS.find((s) => s.session_id === selectedId) ?? null;
  const selectedAgent = FIXTURE_AGENTS.find(
    (a) => a.agent_id === selectedSession?.agent_id,
  );
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: [],
        clientSessionId: FIXTURE_CLIENT_SESSION_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;

  return (
    <div
      data-testid="session-first-shell"
      className="session-first-shell flex h-[100dvh] flex-col bg-background"
    >
      <SessionFirstWorkspace
        agents={FIXTURE_AGENTS}
        filteredSessions={FIXTURE_SESSIONS}
        staleAgents={[]}
        selectedId={selectedId}
        clientSessionId={FIXTURE_CLIENT_SESSION_ID}
        loadingSessions={false}
        searchQuery=""
        setSearchQuery={() => {}}
        statusFilter="all"
        setStatusFilter={() => {}}
        sortField="name"
        sortDirection="desc"
        toggleSort={() => {}}
        isSearchActive={false}
        selectedSession={selectedSession}
        selectedAgent={selectedAgent}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onCreate={() => {}}
        onRefresh={() => {}}
        onSelect={() => {}}
        onKill={() => {}}
        onSurfaceChange={() => {}}
        onToolChange={() => {}}
        onOpenAgent={() => {}}
        isWide
        showList
        showDetail
        onBackToSessions={() => {}}
        onOpenEnv={() => {}}
        onLegacy={() => {}}
        connectionStatus="connected"
        terminal={<FixtureTerminal />}
      />
    </div>
  );
}
```

- [ ] **Step 4: Register the route in App.tsx**

In `web/src/App.tsx`:

```tsx
// add import:
import { FixtureShell } from './session-first/fixture/FixtureShell';

// inside App(), before the two routers:
  const fixtureRoute = { path: '/fixture', element: <FixtureShell /> };

// prepend to BOTH router route arrays:
  const loginRouter = useMemo(
    () => createHashRouter([
      fixtureRoute,
      {
        path: '*',
        // …existing LoginPage route unchanged…
      },
    ]),
    // …existing deps unchanged…
  );

  const appRouter = useMemo(
    () => createHashRouter([
      fixtureRoute,
      {
        path: '/',
        // …existing root unchanged…
      },
    ]),
    // …existing deps unchanged…
  );
```

`fixtureRoute` is module-stable (static element) so it needs no deps in either memo.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx`
Expected: PASS (1 test). (The `data-selected` and `session-header-line` assertions are added in Tasks 6 and 7.)

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/fixture/ web/src/App.tsx
git commit -m "feat: canonical /fixture route rendering the real session-first shell (#561)"
```

---

### Task 5: Remove the global chrome bar (wordmark) — inline the error banner

**Files:**
- Modify: `web/src/session-first/SessionFirstShell.tsx`
- Delete: `web/src/session-first/SessionFirstChrome.tsx`

- [ ] **Step 1: Inline the error banner and drop the header**

In `web/src/session-first/SessionFirstShell.tsx`, replace the `SessionFirstChrome` usage:

```tsx
      {error ? (
        <div
          data-testid="session-first-error"
          className="flex shrink-0 items-center gap-2 bg-destructive/10 px-3 py-2 text-destructive text-sm"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  aria-label="Dismiss error"
                  onClick={() => clearError()}
                />
              }
            >
              <X className="size-3" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Dismiss</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
```

- Add imports to `SessionFirstShell.tsx`: `X` from `lucide-react`; `Tooltip, TooltipContent, TooltipTrigger` from `@/components/ui/tooltip`; `Button` from `@/components/ui/button`.
- Remove `import { SessionFirstChrome } from '@/session-first/SessionFirstChrome';` and the `<SessionFirstChrome connectionStatus={connectionStatus} error={data.error} clearError={data.clearError} />` block. The `connectionStatus` prop stays in use (passed to `SessionFirstWorkspace` for the sidebar footer, Task 3). Delete `SessionFirstChrome.tsx`.

- [ ] **Step 2: Check no test depends on the deleted component**

Run: `grep -rn "SessionFirstChrome\|session-first-chrome" web/src --include="*.tsx" --include="*.ts" | grep -v "SessionFirstShell"`
Expected: no matches (if a test references it, update the test to assert the shell renders without a chrome bar instead).

- [ ] **Step 3: Verify typecheck + tests**

Run: `cd web && npx tsc --noEmit && npx vitest run src/__tests__/integration/App.sessionFirst.test.tsx`
Expected: 0 errors; PASS.

- [ ] **Step 4: Commit**

```bash
git add -A web/src/session-first/
git commit -m "feat: remove global wordmark chrome; error banner stays state-driven (#561)"
```

---

### Task 6: Sidebar — canvas + hairline, accent-bar selection

**Files:**
- Modify: `web/src/session-first/SessionFirstSidebar.tsx`
- Modify: `web/src/session-first/patterns/SessionItem.tsx`

- [ ] **Step 1: Sidebar canvas + hairline**

In `web/src/session-first/SessionFirstSidebar.tsx`, change the `<aside>` className:

```tsx
    <aside
      className={cn(
        'flex h-full w-full shrink-0 flex-col border-r border-border/60 lg:w-72',
        className,
      )}
    >
```

(`bg-sidebar text-sidebar-foreground` removed — same canvas as the app; the hairline `border-r` is the only separator. Keep `lg:w-72`; width convergence is Phase 5.)

- [ ] **Step 2: SessionItem — one coherent selection cue**

In `web/src/session-first/patterns/SessionItem.tsx`, replace the row `<div>`:

```tsx
    <div
      data-testid="session-item-row"
      data-selected={selected}
      className={cn(
        'group relative flex items-start gap-1 px-[var(--sf-space-3)] py-[var(--sf-space-2)] transition-colors hover:bg-muted/40',
      )}
    >
      {selected ? (
        <span
          data-testid="session-item-selected-bar"
          className="absolute bottom-1 left-0 top-1 rounded-r-sm w-0.5 bg-primary"
          aria-hidden="true"
        />
      ) : null}
```

- Remove `rounded-lg` and the `selected && 'bg-muted'` class from the row.
- The session name `<span>` keeps `font-medium` (primary). The kill button keeps its hover/focus/selected disclosure — the `selected && 'opacity-100'` rule stays.

- [ ] **Step 3: Add the selected-count assertion to the FixtureShell test**

Append to `web/src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx`:

```tsx
  it('marks exactly one session as selected', () => {
    render(<FixtureShell />);
    expect(
      screen
        .getAllByTestId('session-item-row')
        .filter((el) => el.getAttribute('data-selected') === 'true'),
    ).toHaveLength(1);
  });
```

- [ ] **Step 4: Run the session-first test suites**

Run: `cd web && npx vitest run src/session-first/ src/__tests__/integration/App.sessionFirst.test.tsx`
Expected: PASS. If any test asserted `bg-muted` or rounded classes, update the assertion to the new cue (`data-selected`).

- [ ] **Step 5: Commit**

- [ ] **Step 4: Commit**

```bash
git add web/src/session-first/
git commit -m "feat: terminal-native sidebar — canvas surface, hairline, accent-bar selection (#561)"
```

---

### Task 7: Session line — mono title, one-line state context, text switcher

**Files:**
- Modify: `web/src/session-first/patterns/SessionHeader.tsx`
- Modify: `web/src/session-first/patterns/ConnectionStatus.tsx`
- Modify: `web/src/session-first/patterns/SurfaceSwitcher.tsx`

- [ ] **Step 1: Restyle SessionHeader into the session line**

Replace `web/src/session-first/patterns/SessionHeader.tsx`:

```tsx
import { ChevronLeft } from 'lucide-react';
import { AgentContext } from '@/session-first/patterns/AgentContext';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import {
  SurfaceSwitcher,
  type Surface,
} from '@/session-first/patterns/SurfaceSwitcher';
import { Button } from '@/components/ui/button';
import type { DomainState } from '@/session-first/domainState';

export type { Surface };

export interface SessionHeaderProps {
  sessionName: string;
  agentLabel: string;
  state: DomainState;
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
  onOpenAgent: () => void;
  onBackToSessions?: () => void;
}

export function SessionHeader({
  sessionName,
  agentLabel,
  state,
  surface,
  onSurfaceChange,
  onOpenAgent,
  onBackToSessions,
}: SessionHeaderProps) {
  return (
    <header
      data-testid="session-header-line"
      className="flex shrink-0 flex-col gap-1 px-[var(--sf-space-4)] py-[var(--sf-space-2)] max-lg:gap-1.5 max-lg:px-[var(--sf-space-3)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        {onBackToSessions ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)] lg:hidden"
            aria-label="Back to sessions"
            data-testid="session-first-back-to-list"
            onClick={() => onBackToSessions()}
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        <h1 className="min-w-0 truncate font-mono text-base font-semibold">
          {sessionName}
        </h1>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <AgentContext agentLabel={agentLabel} state={state} onOpenAgent={onOpenAgent} />
          <ConnectionStatus state={state} />
        </div>
        <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
      </div>
    </header>
  );
}
```

- [ ] **Step 2: ConnectionStatus — compact single muted line with state-driven fragments**

Replace `web/src/session-first/patterns/ConnectionStatus.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type {
  AgentChannel,
  AttachmentChannel,
  DomainState,
  SessionChannel,
} from '@/session-first/domainState';

function agentValueClass(channel: AgentChannel): string {
  switch (channel) {
    case 'online':
      return '';
    case 'offline':
      return 'text-agent-offline';
    case 'error':
      return 'text-agent-error';
  }
}

function sessionValueClass(channel: SessionChannel): string {
  switch (channel) {
    case 'active':
      return '';
    case 'exited':
      return 'text-session-exited';
    case 'unknown':
      return '';
  }
}

function attachmentValueClass(channel: AttachmentChannel): string {
  switch (channel) {
    case 'attached':
      return '';
    case 'failed':
      return 'text-attachment-failed';
    case 'attaching':
      return 'text-attachment-attaching';
    case 'detached':
      return '';
  }
}

/** Muted by default; tailwind-merge lets a domain state class win (cn = clsx + tailwind-merge). */
function fragmentClass(stateClass: string): string {
  return cn('text-muted-foreground', stateClass);
}

/** Compact single-line form: values joined by ·; healthy = fully muted (P3). */
export function ConnectionStatus({ state }: { state: DomainState }) {
  return (
    <div
      data-testid="connection-status"
      className="flex min-w-0 items-center gap-1 text-xs"
    >
      <span data-testid="channel-agent" className={fragmentClass(agentValueClass(state.agent.channel), state.agent.channel)}>
        {state.agent.copy ?? state.agent.channel}
      </span>
      <span className="text-muted-foreground/40">·</span>
      <span data-testid="channel-session" className={fragmentClass(sessionValueClass(state.session.channel), state.session.channel)}>
        {state.session.copy ?? state.session.channel}
      </span>
      <span className="text-muted-foreground/40">·</span>
      <span data-testid="channel-attachment" className={fragmentClass(attachmentValueClass(state.attachment.channel), state.attachment.channel)}>
        {state.attachment.copy ?? state.attachment.channel}
      </span>
    </div>
  );
}
```

(Values remain text — never color-only; labels are dropped in this compact form, matching the pattern spec's "one line with three labeled fragments" compact allowance where values are the labels.)

- [ ] **Step 3: SurfaceSwitcher — text-only, no segmented background**

Replace the `TabsList`/`TabsTrigger` markup in `web/src/session-first/patterns/SurfaceSwitcher.tsx`:

```tsx
      <TabsList className="h-auto gap-0.5 bg-transparent p-0">
        <TabsTrigger
          value="terminal"
          className="rounded-none bg-transparent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground"
        >
          Terminal
        </TabsTrigger>
        <TabsTrigger
          value="workspace"
          className="rounded-none bg-transparent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground"
        >
          Workspace
        </TabsTrigger>
      </TabsList>
```

- [ ] **Step 4: AgentContext — compact mono line member**

In `web/src/session-first/patterns/AgentContext.tsx`, change the root button className `"text-sm"` → `"text-xs font-mono"` (healthy identity stays muted; degraded phrase keeps `font-medium` + domain color).

- [ ] **Step 5: Verify typecheck + tests + the FixtureShell test**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ src/__tests__/integration/App.sessionFirst.test.tsx`
Expected: 0 errors; PASS. Then add the `session-header-line` assertion to `FixtureShell.test.tsx`:

```tsx
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
```

and re-run `npx vitest run src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx` (expected: PASS, 2 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/patterns/
git commit -m "feat: session line — mono title, muted state fragments, text surface switcher (#561)"
```

---

### Task 8: SessionListHeader — quiet chrome

**Files:**
- Modify: `web/src/session-first/patterns/SessionListHeader.tsx`

- [ ] **Step 1: Quiet the header block**

In `web/src/session-first/patterns/SessionListHeader.tsx`:

- Container: keep `border-b` (hairline between header and list), change padding to `p-[var(--sf-space-2)]` (both breakpoints).
- "New Session" button: change to compact ghost, left-aligned:

```tsx
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start rounded-none px-1 text-muted-foreground transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)] hover:text-foreground max-lg:min-h-11"
        data-testid="session-first-create"
        aria-label="Create session"
        disabled={createDisabled}
        onClick={() => onCreate()}
      >
        <Plus className="size-4" />
        New Session
      </Button>
```

- "Filters" trigger: `variant="ghost"` instead of `outline`, keep the rest:

```tsx
              <Button type="button" variant="ghost" size="sm" className="min-h-8 max-lg:min-h-11 text-muted-foreground hover:text-foreground transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]">
                <Filter className="size-4" />
                Filters
              </Button>
```

- Status-filter chips inside the panel keep `outline`/`default` variants (they are interactive state controls, not chrome).

- [ ] **Step 2: Verify tests**

Run: `cd web && npx vitest run src/session-first/`
Expected: PASS (testids `session-first-create`, `session-list-filters` unchanged).

- [ ] **Step 3: Commit**

```bash
git add web/src/session-first/patterns/SessionListHeader.tsx
git commit -m "feat: quiet session list header — ghost actions, hairline separator (#561)"
```

---

### Task 9: E2E canonical fixture spec

**Files:**
- Create: `e2e/specs/fixture-canonical.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// e2e/specs/fixture-canonical.spec.ts
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

test('canonical Active Terminal fixture renders the terminal-native shell', async ({ page }) => {
  await page.goto('/#/fixture');

  await expect(page.getByTestId('session-first-shell')).toBeVisible();
  await expect(page.getByTestId('session-header-line')).toBeVisible();
  await expect(page.getByTestId('session-first-main-content')).toBeVisible();
  await expect(page.getByTestId('terminal-well')).toBeVisible();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();

  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);

  await expect(page.getByTestId('server-connection')).toContainText('server: connected');

  await page.screenshot({ path: 'test-results/canonical-active-terminal.png', fullPage: true });
});
```

- [ ] **Step 2: Build and run the e2e spec**

Run:
```bash
cd web && npm run build
cd ../e2e && npx playwright test fixture-canonical
```
Expected: PASS; screenshot written to `e2e/test-results/canonical-active-terminal.png`.

(If the fixture page renders before the terminal well is laid out, add `await expect(page.getByTestId('fixture-terminal')).toBeVisible()` retries — Playwright auto-waits on `toBeVisible`.)

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/fixture-canonical.spec.ts
git commit -m "test(e2e): canonical Active Terminal fixture spec at 1440×900 (#561)"
```

---

### Task 10: Docs sync — visual language + composition

**Files:**
- Modify: `docs/design/visual-language.md`
- Modify: `docs/design/composition.md`

- [ ] **Step 1: visual-language.md — navigation surface separation**

In `docs/design/visual-language.md` §3 table, change the Navigation surface row:

```text
| Navigation surface | Sessions sidebar | Same canvas; hairline separator (terminal-native) |
```

And add under the §3 rules:

```text
- **R-S6** Approved canonical screen (2026-09-01, #561 Phase 2A): navigation separates by hairline on the same canvas, not by a background block. Background blocks remain reserved for the work surface and state-driven surfaces.
```

- [ ] **Step 2: composition.md — single chrome line**

In `docs/design/composition.md` §1, replace the diagram with the approved shell:

```text
┌──────────────────────┬──────────────────────────────────────────┐
│ search… [▾] +        │ fix-terminal-reconnect                   │
│                      │ devbox-01 · online · active · attached   │ ← session 行
│ ● fix-terminal…      │ [Terminal | Workspace]                   │
│ ● design-system      │ ┌──────────────────────────────────────┐ │
│ ○ prod-shell         │ │                                      │ │
│ ⋮                    │ │      TERMINAL (唯一亮面)              │ │
│ server: connected    │ │            [input  ▸]                │ │
│                      │ └──────────────────────────────────────┘ │
└──────────────────────┴──────────────────────────────────────────┘
```

And update the relationships bullets below it (first bullet becomes):

```text
- The shell is **full-bleed**: no outer page gutter on desktop. There is **no global chrome bar** — no product wordmark, no app-level band. Chrome = the sidebar head row + the session line (≈ 70 px of 900); the Active Surface owns the rest.
```

Also update §3 (header/chrome height strategy) to note the session line is two text rows, not a bordered bar.

- [ ] **Step 3: Commit**

```bash
git add docs/design/visual-language.md docs/design/composition.md
git commit -m "docs(design): sync visual language + composition to approved canonical screen (#561)"
```

---

### Task 11: Full gates + Playwright MCP visual verification + screenshots

- [ ] **Step 1: Web gates**

Run:
```bash
cd web && npm run build && npm run lint && npx tsc --noEmit && npm test
```
Expected: build success; lint 0 warnings; tsc 0 errors; all tests pass.

- [ ] **Step 2: Playwright MCP verification at 1440×900**

Start the local stack (fixture needs no backend, but the repo flow requires the full stack for UI verification):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &   # :19090
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &   # :19091
cd web && npm run dev   # :13000
```

Using Playwright MCP browser tools:
1. `browser_navigate` → `http://localhost:13000/#/fixture`
2. `browser_resize` → 1440×900
3. `browser_snapshot` → verify: 6 session rows, exactly one `data-selected="true"`, session line, terminal well visible
4. `browser_console_messages` → no errors/warnings
5. `browser_take_screenshot` → `filename: ".playwright-mcp/screenshots/canonical-active-terminal.png"` (fullPage)

- [ ] **Step 3: Verify responsive sanity (compact)**

`browser_resize` → 768×1024; assert the shell still renders (sidebar becomes drawer via existing `lg:` rules); screenshot `.playwright-mcp/screenshots/canonical-compact.png`. This is a sanity check, not the canonical frame.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "fix: visual verification fixes for canonical screen (#561)"
```
(Only if fixes were needed; otherwise skip.)

---

### Task 12: Push, PR to staging, screenshots comment

- [ ] **Step 1: Verify branch and push**

```bash
git branch --show-current   # must be feat/web-active-terminal-canonical
git push -u origin feat/web-active-terminal-canonical
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --base staging --title "feat: Web Active Terminal canonical screen — terminal-native chrome + /fixture (#561)" --body "$(cat <<'BODY'
## 变更内容

#561 Phase 2A — Web Active Terminal canonical screen (1440×900), terminal-native chrome:

- 删除全局 chrome 条(无 "Nession" wordmark);错误 banner 保留为状态驱动元素
- Sidebar:同 canvas + 发丝线分隔;选中 cue 收敛为 2px accent 左缘条(data-selected)
- Session 行:等宽标题 + 单行状态上下文(`agent · online · active · attached`,健康全 muted,降级片段转 agent.* 强调色)
- SurfaceSwitcher 纯文本化(无分段背景)
- `/fixture` 确定性路由:真实 SessionFirstWorkspace + 固定 6 session / 3 agent 数据 + 真实 xterm 预写内容,无网络 —— 同时是 Phase 6 golden baseline 的来源
- docs/design 同步(visual-language 表面层级、composition shell 几何)

## 测试报告

- `npm run build`:success
- `npm run lint`:0 warnings
- `npx tsc --noEmit`:0 errors
- `npm test`:全部通过(含 fixtureData / FixtureShell 新测试)
- `npx playwright test fixture-canonical`:PASS(1440×900 结构断言 + 截图 artifact)
- Playwright MCP 1440×900 验证:结构/控制台/截图通过(截图见 PR comment)

Note:#561 Phase 2A,无 Closes(进 release PR)
BODY
)"
```

- [ ] **Step 3: Post screenshots as a PR comment**

```bash
gh pr comment <PR-NUMBER> --body "## Canonical screen (1440×900)

![canonical-active-terminal](.playwright-mcp/screenshots/canonical-active-terminal.png)

![canonical-compact](.playwright-mcp/screenshots/canonical-compact.png)"
```

- [ ] **Step 4: Auto-merge**

```bash
gh pr merge <PR-NUMBER> --auto --merge
```

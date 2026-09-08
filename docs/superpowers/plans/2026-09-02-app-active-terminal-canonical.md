# App Active Terminal Canonical Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the App Active Terminal canonical screen (390×844) — the spatial 3-page experience (Sessions ← Terminal → Workspace) with a single-row App header replacing duplicated floating chrome, per-tool `layout.app` layouts, and a deterministic `/fixture/app` canonical route.

**Architecture:** (1) `SessionHeader` gains an App single-row branch (drawer ≡ + mono session name + muted state fragment + workspace ☰) gated by the existing `experience` prop — no parallel component tree. (2) `SessionFirstSpatialLayout` stops passing `showHeaderActions` (the 44px overlay buttons duplicate the header); the App Workspace page renders a small `AppToolHeader` (← back to Terminal + tool label); `FilesAppLayout` gains its own push sub-header (file path + ← back to tree). (3) `experience` finally threads from `SessionFirstMain` into the `WorkspaceShell` ctx (currently hardcoded `'web'`). (4) `FixtureApp` (`/fixture/app`) renders the full spatial experience at 390×844 with deterministic data + static xterm; e2e stays CI-only.

**Tech Stack:** React 18, Tailwind v4 + shadcn/ui, generated tokens (`--sf-*`, semantic), xterm, Vitest (`__tests__/unit` node / `__tests__/integration` jsdom — the ONLY two dirs vitest collects), Playwright (CI-only — local e2e forbidden).

**Spec:** [`docs/superpowers/specs/2026-09-02-app-active-terminal-canonical-design.md`](../specs/2026-09-02-app-active-terminal-canonical-design.md)

**Conventions to carry over:** local `npx playwright test` is FORBIDDEN (webServer stack + globalSetup `tmux kill-server` disturb the dev tmux) — e2e specs carry `test.skip(!process.env.CI, ...)`; local browser verification uses `vite dev` only (fixtures need no backend). Test paths must be `__tests__/unit/` or `__tests__/integration/` or vitest silently ignores them. `experience` type is `CapsuleExperience` (`'web' | 'app'`) — import from `@/session-first/capsule/types` where a standalone type is needed, or `@/session-first/workspace/toolTypes` (`Experience` re-export) where the workspace already names it.

---

### Task 1: Thread `experience` into the WorkspaceShell ctx

**Files:**
- Modify: `web/src/session-first/SessionFirstMain.tsx` (line ~146 hardcoded `experience: 'web'`)
- Test: `web/src/session-first/__tests__/integration/SessionFirstMain.experience.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/session-first/__tests__/integration/SessionFirstMain.experience.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionFirstMain } from '../SessionFirstMain';
import type { WorkspaceContext } from '../workspace/toolTypes';

let lastCtx: WorkspaceContext | null = null;
vi.mock('../workspace/WorkspaceShell', () => ({
  WorkspaceShell: ({ ctx }: { ctx: WorkspaceContext }) => {
    lastCtx = ctx;
    return <div data-testid="mock-workspace-shell" />;
  },
}));
vi.mock('../SessionFirstTerminal', () => ({
  SessionFirstTerminal: () => <div data-testid="mock-terminal" />,
}));

const base = {
  selectedSession: { session_id: 's1', agent_id: 'devbox-01', session_name: 'fix-terminal-reconnect', status: 'active' as const, window_count: 2, attached_clients: 1, last_activity: '2026-09-01T09:00:00Z' },
  selectedAgent: undefined,
  domain: null,
  surface: 'terminal' as const,
  tool: 'files' as const,
  fileOps: null,
  onSurfaceChange: vi.fn(),
  onToolChange: vi.fn(),
  onOpenAgent: vi.fn(),
  connectionStatus: 'connected' as const,
};

describe('SessionFirstMain experience threading', () => {
  it('passes experience="app" into the workspace ctx', () => {
    render(
      <SessionFirstMain
        {...base}
        domain={{ agent: 'online', session: 'active', attachment: 'attached' } as never}
        experience="app"
      />,
    );
    expect(screen.getByTestId('mock-workspace-shell')).toBeInTheDocument();
    expect(lastCtx?.experience).toBe('app');
  });

  it('defaults to experience="web"', () => {
    render(<SessionFirstMain {...base} domain={{ agent: 'online', session: 'active', attachment: 'attached' } as never} />);
    expect(lastCtx?.experience).toBe('web');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstMain.experience.test.tsx`
Expected: FAIL — `expected 'web' to equal 'app'` (ctx is hardcoded).

- [ ] **Step 3: Thread the prop**

In `web/src/session-first/SessionFirstMain.tsx`, change the WorkspaceShell ctx (line ~146):

```tsx
                  ctx={{
                    session: selectedSession,
                    agent: selectedAgent,
                    domain,
                    fileOps,
                    experience,
                    onToolChange,
                  }}
```

(`experience` is already a destructured prop with default `'web'` — nothing else changes.)

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `cd web && npx vitest run src/session-first/__tests__/integration/SessionFirstMain.experience.test.tsx && npx tsc --noEmit`
Expected: PASS (2 tests); tsc 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/SessionFirstMain.tsx web/src/session-first/__tests__/integration/SessionFirstMain.experience.test.tsx
git commit -m "feat: thread experience through to the workspace ctx (#561)"
```

---

### Task 2: SessionHeader App single-row branch + onOpenWorkspace

**Files:**
- Modify: `web/src/session-first/patterns/SessionHeader.tsx`
- Modify: `web/src/session-first/SessionFirstMain.tsx` (forward `onOpenWorkspace`)
- Test: `web/src/session-first/__tests__/integration/SessionHeader.app.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/session-first/__tests__/integration/SessionHeader.app.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionHeader } from '../SessionHeader';

const base = {
  sessionName: 'fix-terminal-reconnect',
  agentLabel: 'devbox-01',
  state: { agent: 'online', session: 'active', attachment: 'attached' } as never,
  surface: 'terminal' as const,
  onSurfaceChange: vi.fn(),
  onOpenAgent: vi.fn(),
};

describe('SessionHeader app branch', () => {
  it('renders a single row: sessions, name, state fragment, workspace', () => {
    render(
      <SessionHeader
        {...base}
        experience="app"
        onOpenDrawer={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByText('fix-terminal-reconnect')).toBeInTheDocument();
    // state fragment survives compression (no status collapsing)
    expect(screen.getByTestId('connection-status-line')).toBeInTheDocument();
  });

  it('does not render the Terminal|Workspace switcher in app', () => {
    render(<SessionHeader {...base} experience="app" />);
    expect(screen.queryByTestId('surface-switcher')).not.toBeInTheDocument();
  });

  it('fires onOpenWorkspace from the ☰ button', async () => {
    const onOpenWorkspace = vi.fn();
    render(<SessionHeader {...base} experience="app" onOpenWorkspace={onOpenWorkspace} />);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByTestId('app-header-workspace'));
    expect(onOpenWorkspace).toHaveBeenCalled();
  });
});
```

(Verify the ConnectionStatus component's actual testid before writing — read `web/src/session-first/patterns/ConnectionStatus.tsx` and use its real testid in the assertion; if it has none, assert on the muted fragment text instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/__tests__/integration/SessionHeader.app.test.tsx`
Expected: FAIL — `app-header-workspace` not found.

- [ ] **Step 3: App single-row branch in SessionHeader**

In `web/src/session-first/patterns/SessionHeader.tsx`:

- Add prop `onOpenWorkspace?: () => void;` to `SessionHeaderProps`.
- Early-return the app branch before the existing two-row header (import `PanelRight` from `lucide-react`):

```tsx
  if (experience === 'app') {
    return (
      <header
        data-testid="session-header-line"
        className="flex shrink-0 items-center gap-2 px-[var(--sf-space-3)] pt-[max(var(--sf-space-2),env(safe-area-inset-top))]"
      >
        {onOpenDrawer ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
            aria-label="Sessions"
            data-testid="app-header-sessions"
            onClick={() => onOpenDrawer()}
          >
            <Menu className="size-5" />
          </Button>
        ) : null}
        <h1 className="min-w-0 truncate font-mono text-base font-semibold">{sessionName}</h1>
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
          <SessionConnectionStatus state={state} />
        </div>
        {onOpenWorkspace ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
            aria-label="Workspace"
            data-testid="app-header-workspace"
            onClick={() => onOpenWorkspace()}
          >
            <PanelRight className="size-5" />
          </Button>
        ) : null}
      </header>
    );
  }
```

(Check the existing ConnectionStatus import name in this file — it is imported as `SessionConnectionStatus`; keep that alias.)

- [ ] **Step 4: Forward `onOpenWorkspace` from SessionFirstMain**

In `web/src/session-first/SessionFirstMain.tsx`: add `onOpenWorkspace?: () => void;` to `SessionFirstMainProps`, destructure it, and pass to `SessionHeader`.

- [ ] **Step 5: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ && npm run lint`
Expected: 0 errors; PASS (new + existing SessionHeader/SessionFirstMain tests); 0 warnings. (The existing `threads experience to the header` test in `SessionFirstMain.test.tsx` keeps passing — web branch unchanged.)

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/
git commit -m "feat: app single-row header — sessions, session line, workspace affordance (#561)"
```

---

### Task 3: Chrome dedup — drop overlay buttons, AppToolHeader on the Workspace page

**Files:**
- Modify: `web/src/session-first/SessionFirstSpatialLayout.tsx` (stop passing `showHeaderActions`; wire app navigation callbacks)
- Create: `web/src/session-first/patterns/AppToolHeader.tsx`
- Modify: `web/src/session-first/SessionFirstMain.tsx` (render AppToolHeader on the app Workspace page)
- Test: `web/src/session-first/__tests__/integration/AppToolHeader.test.tsx` (new)

- [ ] **Step 1: Write the failing AppToolHeader test**

```tsx
// web/src/session-first/__tests__/integration/AppToolHeader.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppToolHeader } from '../AppToolHeader';

describe('AppToolHeader', () => {
  it('renders back affordance and the tool label', () => {
    render(<AppToolHeader toolLabel="Files" onBack={vi.fn()} />);
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('app-tool-back')).toBeInTheDocument();
  });

  it('fires onBack from the ← button', async () => {
    const onBack = vi.fn();
    render(<AppToolHeader toolLabel="Files" onBack={onBack} />);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByTestId('app-tool-back'));
    expect(onBack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/__tests__/integration/AppToolHeader.test.tsx`
Expected: FAIL — `Cannot find module '../AppToolHeader'`.

- [ ] **Step 3: Write AppToolHeader**

```tsx
// web/src/session-first/patterns/AppToolHeader.tsx
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface AppToolHeaderProps {
  toolLabel: string;
  /** Top-level navigation: back to the Terminal page (never internal push). */
  onBack: () => void;
}

/**
 * App Workspace-page header: single row — back to Terminal + current tool
 * name. Tool-internal push/pop (e.g. the file viewer) renders its own
 * sub-header inside the tool layout, so this back is always top-level.
 */
export function AppToolHeader({ toolLabel, onBack }: AppToolHeaderProps) {
  return (
    <header
      data-testid="app-tool-header"
      className="flex shrink-0 items-center gap-1 px-[var(--sf-space-2)] pt-[max(var(--sf-space-1),env(safe-area-inset-top))]"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        aria-label="Back to terminal"
        data-testid="app-tool-back"
        onClick={onBack}
      >
        <ChevronLeft className="size-5" />
      </Button>
      <h1 className="min-w-0 truncate font-mono text-sm font-semibold">{toolLabel}</h1>
    </header>
  );
}
```

- [ ] **Step 4: Render it on the app Workspace page + drop the overlay buttons**

In `web/src/session-first/SessionFirstMain.tsx`:
- Import `AppToolHeader` and `WORKSPACE_TOOLS`.
- In the `showWorkspace` block, when `experience === 'app'`, render the header above `WorkspaceShell`; the tabpanel wrapper needs `flex flex-col`:

```tsx
            {showWorkspace ? (
              <div
                role="tabpanel"
                id="workspace-tool-panel"
                aria-labelledby={`workspace-tool-tab-${tool}`}
                className={cn('flex min-h-0 flex-1 flex-col', surface !== 'workspace' && 'hidden')}
              >
                {experience === 'app' ? (
                  <AppToolHeader
                    toolLabel={WORKSPACE_TOOLS.find((t) => t.id === tool)?.label ?? ''}
                    onBack={() => onSurfaceChange('terminal')}
                  />
                ) : null}
                <WorkspaceShell
                  ctx={{ session: selectedSession, agent: selectedAgent, domain, fileOps, experience, onToolChange }}
                  activeTool={tool}
                />
              </div>
            ) : null}
```

In `web/src/session-first/SessionFirstSpatialLayout.tsx`:
- Remove `showHeaderActions` from the `AppSpatialShell` props.
- Terminal page `SessionFirstMain` gains the app navigation callbacks:

```tsx
            <SessionFirstMain
              {...mainShared}
              surface="terminal"
              showWorkspace={false}
              experience="app"
              onOpenDrawer={() => onIndexChange(0)}
              onOpenWorkspace={() => onIndexChange(2)}
            />
```

(Workspace page `SessionFirstMain` needs nothing new — `onSurfaceChange` from `mainShared` already flows into AppToolHeader's `onBack`.)

- [ ] **Step 5: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ && npm run lint`
Expected: 0 errors; PASS; 0 warnings. (AppSpatialShell tests may assert the overlay buttons — update any test that renders `showHeaderActions` to assert their absence by default.)

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/
git commit -m "feat: app chrome dedup — single navigation affordance per page (#561)"
```

---

### Task 4: Files push sub-header + session/agent app layouts

**Files:**
- Modify: `web/src/session-first/workspace/tools/filesApp.tsx` (push sub-header)
- Modify: `web/src/session-first/workspace/tools/session.tsx` (app layout container)
- Modify: `web/src/session-first/workspace/tools/agent.tsx` (app layout container)
- Test: `web/src/session-first/workspace/__tests__/integration/filesApp.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/session-first/workspace/__tests__/integration/filesApp.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilesAppLayout } from '../tools/filesApp';
import type { WorkspaceContext } from '../toolTypes';

const ctx: WorkspaceContext = {
  session: null,
  agent: undefined,
  domain: null,
  fileOps: {
    list: vi.fn().mockResolvedValue([
      { path: 'docs', name: 'docs', type: 'dir', size: 0 },
      { path: 'docs/visual-language.md', name: 'visual-language.md', type: 'file', size: 100 },
    ]),
    read: vi.fn().mockResolvedValue({ contents: 'hello', encoding: 'utf-8' as const, truncated: false, has_more: false, offset: 0 }),
  } as never,
  experience: 'app',
  onToolChange: vi.fn(),
};

describe('FilesAppLayout', () => {
  it('renders the tree full-screen with no sub-header', () => {
    render(<FilesAppLayout ctx={ctx} />);
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
  });

  it('pushes the editor with a sub-header and back affordance', async () => {
    render(<FilesAppLayout ctx={ctx} />);
    const user = (await import('@testing-library/user-event')).default;
    const row = await screen.findByText('visual-language.md');
    await user.click(row);
    expect(screen.getByTestId('files-app-nav')).toBeInTheDocument();
    expect(screen.getByTestId('files-app-back')).toBeInTheDocument();
    await user.click(screen.getByTestId('files-app-back'));
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
  });
});
```

(Verify `FileEntry`'s real shape and `FileBrowser`'s click behavior before writing — read `web/src/services/fileOps.ts` and `web/src/components/FileBrowser.tsx`; the tree row may render the name inside a button with its own testid — adjust the selector to something that works, e.g. click by `text=visual-language.md`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/workspace/__tests__/integration/filesApp.test.tsx`
Expected: FAIL — `files-app-nav` never appears (current push renders the bare FileViewer).

- [ ] **Step 3: Push sub-header in filesApp**

Rewrite `web/src/session-first/workspace/tools/filesApp.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/** App layout: tree full-screen → push editor with a sub-header (← + path). */
export function FilesAppLayout({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);

  // Reset the viewer when the transport changes (detach/reattach or session
  // switch) so a stale file view from a previous session never reappears.
  useEffect(() => {
    setSelected(null);
  }, [ctx.fileOps]);

  if (!ctx.fileOps) {
    return null;
  }
  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          data-testid="files-app-nav"
          className="flex shrink-0 items-center gap-1 px-[var(--sf-space-2)] pt-[max(var(--sf-space-1),env(safe-area-inset-top))]"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            aria-label="Back to files"
            data-testid="files-app-back"
            onClick={() => setSelected(null)}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className="min-w-0 truncate font-mono text-sm">{selected.filename}</span>
        </div>
        <div className="min-h-0 flex-1">
          <FileViewer
            key={selected.path}
            fileOps={ctx.fileOps}
            path={selected.path}
            filename={selected.filename}
            fileSize={selected.size}
            onClose={() => setSelected(null)}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden" data-testid="files-app-layout">
      <FileBrowser
        fileOps={ctx.fileOps}
        onFileClick={(entry: FileEntry) =>
          setSelected({ path: entry.path, filename: entry.name, size: entry.size })
        }
      />
    </div>
  );
}
```

- [ ] **Step 4: App containers for session/agent layouts**

In `web/src/session-first/workspace/tools/session.tsx`, replace the `app` layout:

```tsx
    app: ({ ctx }) =>
      ctx.session && ctx.domain ? (
        <div
          data-testid="session-details-app"
          className="h-full min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        >
          <SessionDetails session={ctx.session} state={ctx.domain} />
        </div>
      ) : null,
```

In `web/src/session-first/workspace/tools/agent.tsx`, replace the `app` layout:

```tsx
    app: ({ ctx }) =>
      ctx.agent && ctx.domain ? (
        <div
          data-testid="agent-detail-app"
          className="h-full min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        >
          <AgentDetail agent={ctx.agent} state={ctx.domain} />
        </div>
      ) : null,
```

- [ ] **Step 5: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ && npm run lint`
Expected: 0 errors; PASS; 0 warnings. (Check whether an existing `filesApp`/registry test asserts the old bare-push structure and update it to the sub-header structure.)

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/workspace/
git commit -m "feat: files push sub-header, app containers for session/agent tools (#561)"
```

---

### Task 5: FixtureApp — canonical 390×844 spatial screen

**Files:**
- Create: `web/src/session-first/fixture/FixtureApp.tsx`
- Modify: `web/src/App.tsx` (route, both routers)
- Test: `web/src/session-first/fixture/__tests__/integration/FixtureApp.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/session-first/fixture/__tests__/integration/FixtureApp.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FixtureApp } from '../FixtureApp';

describe('FixtureApp', () => {
  it('renders the spatial shell with the terminal page active', () => {
    render(<FixtureApp />);
    expect(screen.getByTestId('app-spatial-shell')).toBeInTheDocument();
    expect(screen.getByTestId('session-header-line')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('app-header-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
  });

  it('navigates to the workspace page via ☰ and back via ←', async () => {
    render(<FixtureApp />);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByTestId('app-header-workspace'));
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    await user.click(screen.getByTestId('app-tool-back'));
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument();
  });

  it('opens the sessions page via the header ≡ button', async () => {
    render(<FixtureApp />);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByTestId('app-header-sessions'));
    expect(screen.getByTestId('session-first-sidebar')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/fixture/__tests__/integration/FixtureApp.test.tsx`
Expected: FAIL — `Cannot find module '../FixtureApp'`.

- [ ] **Step 3: Write FixtureApp**

```tsx
// web/src/session-first/fixture/FixtureApp.tsx
import { useState } from 'react';
import { TerminalScrollOverlay } from '@/components/TerminalScrollOverlay';
import {
  AppSpatialShell,
  type SpatialPageIndex,
} from '@/session-first/app-spatial/AppSpatialShell';
import { mapDomainState } from '@/session-first/domainState';
import { FixtureTerminal } from '@/session-first/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/session-first/fixture/fixtureData';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import { SessionFirstSidebar } from '@/session-first/SessionFirstSidebar';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/workspace/toolTypes';
import { fixtureFileOps } from './fixtureFileOps';

// Module-stable — the stub is immutable and stateless (same pattern as
// FixtureWorkspace's fixtureOps).
const fixtureOps = fixtureFileOps();

/**
 * Canonical App Active Terminal screen (#561 Phase 2C): the spatial
 * 3-page pager at 390×844 — single-row App header, static terminal with
 * the app scroll overlay, files plugin app layout, deterministic data.
 * No network. Also the Phase 6 baseline source.
 */
export function FixtureApp() {
  const [spatialIndex, setSpatialIndex] = useState<SpatialPageIndex>(1);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<WorkspaceToolId>('files');

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

  const sidebarProps = {
    agents: FIXTURE_AGENTS,
    filteredSessions: FIXTURE_SESSIONS,
    staleAgents: [],
    selectedId,
    clientSessionId: FIXTURE_CLIENT_SESSION_ID,
    loadingSessions: false,
    searchQuery: '',
    setSearchQuery: () => {},
    statusFilter: 'all' as const,
    setStatusFilter: () => {},
    sortField: 'name' as const,
    sortDirection: 'desc' as const,
    toggleSort: () => {},
    isSearchActive: false,
    onCreate: () => {},
    onRefresh: () => {},
    onKill: () => {},
    onOpenEnv: () => {},
    onLegacy: () => {},
  };

  const mainShared = {
    selectedSession,
    selectedAgent,
    domain,
    tool,
    fileOps: fixtureOps,
    connectionStatus: 'connected' as const,
    onSurfaceChange: (s: Surface) => {
      setSurface(s);
      setSpatialIndex(s === 'workspace' ? 2 : 1);
    },
    onToolChange: setTool,
    onOpenAgent: () => {},
  };

  return (
    <div
      data-testid="session-first-shell"
      data-sf-design="polish"
      className="session-first-shell flex h-[100dvh] flex-col bg-background"
    >
      <AppSpatialShell
        index={spatialIndex}
        onIndexChange={(index) => {
          setSpatialIndex(index);
          setSurface(index === 2 ? 'workspace' : 'terminal');
        }}
        sessions={
          <SessionFirstSidebar
            {...sidebarProps}
            onSelect={() => setSpatialIndex(1)}
          />
        }
        terminal={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface="terminal"
              showWorkspace={false}
              experience="app"
              onOpenDrawer={() => setSpatialIndex(0)}
              onOpenWorkspace={() => setSpatialIndex(2)}
              terminal={
                <div className="relative h-full">
                  <FixtureTerminal />
                  <TerminalScrollOverlay
                    onScrollPages={() => {}}
                    onScrollToBottom={() => {}}
                  />
                </div>
              }
            />
          </div>
        }
        workspace={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface="workspace"
              showTerminal={false}
              experience="app"
            />
          </div>
        }
      />
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

In `web/src/App.tsx`:
- Import `FixtureApp`.
- Add module-scope `const fixtureAppRoute = { path: '/fixture/app', element: <FixtureApp /> };`
- Add `fixtureAppRoute,` to BOTH router arrays (login + app), alongside `fixtureWorkspaceRoute` / `fixtureRoute`.

- [ ] **Step 5: Sessions-page list header — verify, do not rebuild**

The spec says the Sessions-page list header "converges to a single row". The existing `SessionListHeader` is already compact for narrow widths (SearchBar row + New Session row + Filters/Refresh row, `max-lg:min-h-11` touch targets) and is NOT the Terminal-page header — it is the list page's own tool row, so it does not duplicate chrome. No change is required at 390px; if the browser verification (Task 8) shows it wrapping to more rows at 390px, compress spacing only (`gap`/`p` token values), never restructure.

- [ ] **Step 6: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/fixture && npm run lint`
Expected: 0 errors; PASS (FixtureShell + FixtureWorkspace + new FixtureApp tests); 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add web/src/
git commit -m "feat: app canonical fixture — spatial 3-page shell at 390×844 (#561)"
```

---

### Task 6: E2E — app fixture spec (CI-only)

**Files:**
- Create: `e2e/specs/fixture-app.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// e2e/specs/fixture-app.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 390, height: 844 } });

test('canonical App fixture renders the spatial terminal page', async ({ page }) => {
  await page.goto('/#/fixture/app');

  await expect(page.getByTestId('session-first-shell')).toBeVisible();
  await expect(page.getByTestId('app-spatial-shell')).toBeVisible();

  // single-row header: sessions + workspace affordances, NO switcher, NO
  // duplicated floating buttons
  await expect(page.getByTestId('session-header-line')).toBeVisible();
  await expect(page.getByTestId('app-header-sessions')).toBeVisible();
  await expect(page.getByTestId('app-header-workspace')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
  await expect(page.getByTestId('app-spatial-open-sessions')).toHaveCount(0);

  // terminal surface dominant, scroll overlay present
  await expect(page.getByTestId('terminal-well')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-app-terminal.png', fullPage: true });
});

test('App workspace page shows the files plugin app layout', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  await expect(page.getByTestId('app-tool-header')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-app-workspace.png', fullPage: true });
});
```

- [ ] **Step 2: Static verification only (no local run)**

Run: `cd e2e && npx playwright test --list` — discovers `fixture-app.spec.ts` (no webServers spawned).

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/fixture-app.spec.ts
git commit -m "test(e2e): canonical App fixture spec at 390×844, CI-only (#561)"
```

---

### Task 7: Docs sync

**Files:**
- Modify: `docs/design/composition.md`
- Modify: `docs/design/interaction/app.md`
- Modify: `docs/design/workspace.md`

- [ ] **Step 1: composition.md — App composition section**

In `docs/design/composition.md`, extend §9 (Web vs App composition): add the App chrome rules from this phase —

- App pages carry a **single-row header** (`[≡] session · state fragment [☰]` on Terminal, `[←] tool label` on Workspace) at ≈48px + top safe-area; the 44px overlay buttons are removed — one visible navigation affordance per page (plus edge-band gestures as accelerators, never the only path).
- Touch targets ≥ 44px (`experience.app.touchTarget.min` semantics); all sizes from tokens/`env()` — no fixed px.
- Workspace tools own their push/pop sub-navigation (files editor sub-header); top-level back always returns to Terminal.

- [ ] **Step 2: interaction/app.md — mark the chrome model landed**

Update `docs/design/interaction/app.md` (check its current state in the worktree first — the root WIP version may differ from what staging has; edit the staging copy): note that the visible non-gesture controls are now the single-row header (≡ / ☰ / ←) and the bottom floating tool bar; the overlay PanelLeft/PanelRight buttons are gone; "no shrunken Web workspace" is enforced by `layout.app` per tool.

- [ ] **Step 3: workspace.md — app layout notes**

Add to the Files tool paragraph: push state renders a tool-internal sub-header (`←` + file path) so internal push/pop never fights the top-level back; session/agent tools provide app containers (full-screen scroll + bottom safe-area) rather than shared fallbacks.

- [ ] **Step 4: Commit**

```bash
git add docs/design/
git commit -m "docs(design): sync App composition — single-row header, chrome dedup, tool push navigation (#561)"
```

---

### Task 8: Full gates + browser verification + screenshots

- [ ] **Step 1: Web gates**

Run: `cd web && npm run build && npm run lint && npx tsc --noEmit && npm test`
Expected: build success; lint 0 warnings; tsc 0 errors; all tests pass.

- [ ] **Step 2: Browser verification (vite dev only — no backend, no tmux)**

```bash
cd web && npm run dev   # :13000
```

Using a small Playwright script (pattern from 2B: chromium from `e2e/node_modules/playwright-core`):
1. `/#/fixture/app` at 390×844 — spatial shell: single-row header (≡/☰), no switcher, no overlay buttons, terminal dominant, scroll overlay visible.
2. Click `app-header-workspace` → `app-tool-header` + `files-app-layout` + bottom tool bar; click a fixture file → `files-app-nav` sub-header appears; back returns to tree.
3. Console: no errors (jotai atomFamily deprecation warning is pre-existing).
4. Screenshots → `.playwright-mcp/screenshots/canonical-app-terminal.png` + `canonical-app-workspace.png` + `canonical-app-files-push.png`.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "fix: visual verification fixes for app canonical screen (#561)"
```
(Only if fixes were needed.)

---

### Task 9: Push, PR to staging, screenshots comment

- [ ] **Step 1: Verify branch and push**

```bash
git branch --show-current   # must be feat/app-active-terminal-canonical
git push -u origin feat/app-active-terminal-canonical
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --base staging --title "feat: App Active Terminal canonical screen — spatial experience at 390×844 (#561)" --body "$(cat <<'BODY'
## 变更内容

#561 Phase 2C — App Active Terminal canonical screen(390×844),整个 App 空间体验 polish:

- **chrome 去重**:移除终端页 44px 浮动按钮(与头部重复);每页单一可见导航入口
- **单行头部(App)**:`[≡] 会话名 · 状态片段 [☰]`(Terminal 页)/ `[←] 工具名`(Workspace 页);≥44px 触控目标,safe-area 顶部;状态压缩不折叠
- **experience 穿透**:SessionFirstMain 硬编码 'web' → 真实 prop,workspace 插件 ctx 与终端全链路生效
- **三工具 layout.app**:files push 子头部(← + 路径);session/agent App 容器(全屏滚动 + 底部 safe-area)
- **FixtureApp** `/fixture/app`:390×844 空间 3 页 + 静态终端 + scroll overlay + filesApp,确定性数据
- **e2e**:fixture-app spec(CI-only,390×844)
- **docs**:composition §9 App 组合、interaction/app.md 落地、workspace.md push 导航

⚠️ 发布注意延续:visual-language/composition/workspace 在 main 与 staging 内容冲突(超集,取本分支)。

## 测试报告

- `npm run build` / `npm run lint` / `npx tsc --noEmit`:全绿
- `npm test`:全部通过(SessionHeader app 分支 / AppToolHeader / filesApp push / FixtureApp / experience 穿透新测试)
- e2e fixture-app:CI-only,`--list` 验证,CI 由 e2e.yml 跑
- 浏览器验证(390×844,vite dev 无后端):终端页 / workspace 页 / files push 子头部,console 干净;截图见 PR comment

Note:#561 Phase 2C — 无 `Closes`(进 release PR)
BODY
)"
```

- [ ] **Step 3: Post screenshots**

```bash
gh pr comment <PR-NUMBER> --body "## Canonical App screens (390×844)

![app-terminal](.playwright-mcp/screenshots/canonical-app-terminal.png)

![app-workspace](.playwright-mcp/screenshots/canonical-app-workspace.png)

![app-files-push](.playwright-mcp/screenshots/canonical-app-files-push.png)"
```

- [ ] **Step 4: Auto-merge**

```bash
gh pr merge <PR-NUMBER> --auto --merge
```

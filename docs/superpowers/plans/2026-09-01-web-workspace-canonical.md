# Web Workspace Canonical Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the Web Workspace / Files canonical screen (1440×900) with a workspace plugin framework — bottom floating tool bar, per-tool Web/App layouts on grids/proportions — and move the Web shell to the AI-style resting layout (sessions drawer, single top row, full-bleed Terminal).

**Architecture:** (1) A `WorkspaceTool` contract + registry makes each tool (Files/Session/Agent) a plugin owning its `layout.web` / `layout.app`; a `WorkspaceShell` framework renders the registry-driven bottom floating tool bar and the active tool's layout. (2) The resting Web shell removes the persistent sidebar: `[≡]` opens a sessions drawer (reusing 2A's list components), the top row (drawer button + session line + switcher + server micro-status) is the only chrome. (3) The App experience stops rendering the `[Terminal | Workspace]` switcher. (4) Fixture gains a workspace variant + drawer state; e2e stays CI-only.

**Tech Stack:** React 18, Tailwind v4 + shadcn/ui, generated tokens (`--sf-*`, semantic), xterm, Vitest (`__tests__/unit` node / `__tests__/integration` jsdom — the ONLY two dirs vitest collects), Playwright (CI-only — local e2e forbidden).

**Spec:** [`docs/superpowers/specs/2026-09-01-web-workspace-canonical-design.md`](../specs/2026-09-01-web-workspace-canonical-design.md)

**2A conventions to carry over:** local `npx playwright test` is FORBIDDEN (webServer stack + globalSetup `tmux kill-server` disturb the dev tmux) — e2e specs carry `test.skip(!process.env.CI, ...)`; local browser verification uses `vite dev` only (the fixture needs no backend). Test paths must be `__tests__/unit/` or `__tests__/integration/` or vitest silently ignores them.

---

### Task 1: Workspace tool contract + registry

**Files:**
- Create: `web/src/session-first/workspace/toolTypes.ts`
- Create: `web/src/session-first/workspace/tools/files.tsx`
- Create: `web/src/session-first/workspace/tools/session.tsx`
- Create: `web/src/session-first/workspace/tools/agent.tsx`
- Create: `web/src/session-first/workspace/tools/index.ts`
- Test: `web/src/session-first/workspace/__tests__/unit/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/session-first/workspace/__tests__/unit/registry.test.ts
import { describe, expect, it } from 'vitest';
import { WORKSPACE_TOOLS } from '../tools';

describe('workspace tool registry', () => {
  it('registers files, session and agent', () => {
    expect(WORKSPACE_TOOLS.map((t) => t.id)).toEqual(['files', 'session', 'agent']);
  });

  it('ids are unique', () => {
    const ids = WORKSPACE_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each tool provides web and app layouts', () => {
    for (const tool of WORKSPACE_TOOLS) {
      expect(typeof tool.layout.web).toBe('function');
      expect(typeof tool.layout.app).toBe('function');
    }
  });

  it('files requires fileOps (availability)', () => {
    const files = WORKSPACE_TOOLS.find((t) => t.id === 'files')!;
    expect(files.availability({ fileOps: null } as never)).toBe(false);
    expect(files.availability({ fileOps: {} } as never)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/workspace/__tests__/unit/registry.test.ts`
Expected: FAIL — `Cannot find module '../tools'`

- [ ] **Step 3: Write the contract**

```ts
// web/src/session-first/workspace/toolTypes.ts
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { DomainState } from '@/session-first/domainState';
import type { FileOps } from '@/services/fileOps';
import type { Agent, Session } from '@/types';

export type WorkspaceToolId = 'files' | 'session' | 'agent';
export type Experience = 'web' | 'app';

/** Everything a tool layout needs from the workspace framework. */
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: Experience;
  onToolChange: (id: WorkspaceToolId) => void;
}

/**
 * A workspace tool is a plugin: it owns its label/icon/order/availability
 * and its own layouts per experience. Adding a tool = one file + one
 * registry line; the framework does not change.
 */
export interface WorkspaceTool {
  id: WorkspaceToolId;
  label: string;
  icon: LucideIcon;
  order: number;
  availability: (ctx: WorkspaceContext) => boolean;
  layout: {
    web: ComponentType<{ ctx: WorkspaceContext }>;
    app: ComponentType<{ ctx: WorkspaceContext }>;
  };
}
```

- [ ] **Step 4: Write the three tool registrations (layout components arrive in Tasks 3–4; register placeholders that render the existing components for now)**

```tsx
// web/src/session-first/workspace/tools/files.tsx
import { FileText } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';

export const filesTool: WorkspaceTool = {
  id: 'files',
  label: 'Files',
  icon: FileText,
  order: 10,
  availability: (ctx) => ctx.fileOps !== null,
  layout: {
    // Task 3 replaces these with grid web / push-app layouts.
    web: ({ ctx }) => <FileWorkspace fileOps={ctx.fileOps} />,
    app: ({ ctx }) => <FileWorkspace fileOps={ctx.fileOps} />,
  },
};
```

```tsx
// web/src/session-first/workspace/tools/session.tsx
import { Settings2 } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { SessionDetails } from '@/session-first/SessionDetails';

export const sessionTool: WorkspaceTool = {
  id: 'session',
  label: 'Session',
  icon: Settings2,
  order: 20,
  availability: () => true,
  layout: {
    web: ({ ctx }) => (ctx.session && ctx.domain ? <SessionDetails session={ctx.session} state={ctx.domain} /> : null),
    app: ({ ctx }) => (ctx.session && ctx.domain ? <SessionDetails session={ctx.session} state={ctx.domain} /> : null),
  },
};
```

```tsx
// web/src/session-first/workspace/tools/agent.tsx
import { UserRound } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { AgentDetail } from '@/session-first/patterns/AgentDetail';

export const agentTool: WorkspaceTool = {
  id: 'agent',
  label: 'Agent',
  icon: UserRound,
  order: 30,
  availability: () => true,
  layout: {
    web: ({ ctx }) => (ctx.agent && ctx.domain ? <AgentDetail agent={ctx.agent} state={ctx.domain} /> : null),
    app: ({ ctx }) => (ctx.agent && ctx.domain ? <AgentDetail agent={ctx.agent} state={ctx.domain} /> : null),
  },
};
```

```ts
// web/src/session-first/workspace/tools/index.ts
import { agentTool } from './agent';
import { filesTool } from './files';
import { sessionTool } from './session';

export const WORKSPACE_TOOLS = [filesTool, sessionTool, agentTool];

export type { WorkspaceContext, WorkspaceTool, WorkspaceToolId, Experience } from '../toolTypes';
```

(Verify `SessionDetails` props are `{ session, state }` and `AgentDetail` is `{ agent, state }` by reading the files; adjust the JSX to the real prop names if they differ — tsc is the arbiter, do NOT change the components' prop types.)

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `cd web && npx vitest run src/session-first/workspace/__tests__/unit/registry.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests); tsc 0 errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/session-first/workspace/
git commit -m "feat: workspace tool contract and registry (#561)"
```

---

### Task 2: WorkspaceShell — framework container + bottom floating tool bar

**Files:**
- Create: `web/src/session-first/workspace/WorkspaceShell.tsx`
- Test: `web/src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShell } from '../WorkspaceShell';
import { WORKSPACE_TOOLS } from '../tools';
import type { WorkspaceContext } from '../toolTypes';

const ctx: WorkspaceContext = {
  session: null,
  agent: undefined,
  domain: null,
  fileOps: null,
  experience: 'web',
  onToolChange: vi.fn(),
};

vi.mock('../tools/files', () => ({ filesTool: { ...require('../tools').WORKSPACE_TOOLS[0], layout: { web: () => <div data-testid="mock-files-web" />, app: () => <div /> } } }));

describe('WorkspaceShell', () => {
  it('renders the bottom floating tool bar from the registry', () => {
    render(<WorkspaceShell ctx={ctx} activeTool="files" />);
    expect(screen.getByTestId('workspace-tool-bar')).toBeInTheDocument();
    for (const tool of WORKSPACE_TOOLS) {
      expect(screen.getByText(tool.label)).toBeInTheDocument();
    }
  });

  it('renders the active tool web layout', () => {
    render(<WorkspaceShell ctx={ctx} activeTool="files" />);
    expect(screen.getByTestId('mock-files-web')).toBeInTheDocument();
  });

  it('marks unavailable tools disabled in the bar', () => {
    render(<WorkspaceShell ctx={ctx} activeTool="session" />);
    const filesTab = screen.getByRole('tab', { name: 'Files' });
    expect(filesTab).toBeDisabled();
  });

  it('calls onToolChange when a bar item is clicked', async () => {
    const user = (await import('@testing-library/user-event')).default;
    render(<WorkspaceShell ctx={{ ...ctx, fileOps: {} as never }} activeTool="files" />);
    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(ctx.onToolChange).toHaveBeenCalledWith('agent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx`
Expected: FAIL — `Cannot find module '../WorkspaceShell'`

- [ ] **Step 3: Write WorkspaceShell**

```tsx
// web/src/session-first/workspace/WorkspaceShell.tsx
import { cn } from '@/lib/utils';
import { WORKSPACE_TOOLS } from '@/session-first/workspace/tools';
import type { WorkspaceContext, WorkspaceToolId } from '@/session-first/workspace/toolTypes';

export interface WorkspaceShellProps {
  ctx: WorkspaceContext;
  activeTool: WorkspaceToolId;
}

/**
 * Workspace framework: renders the registry-driven bottom floating tool bar
 * and the active tool's layout for the current experience. The tool content
 * area sits on the workspace ground tier; the floating bar is the only
 * elevated element (capsule family).
 */
export function WorkspaceShell({ ctx, activeTool }: WorkspaceShellProps) {
  const active = WORKSPACE_TOOLS.find((t) => t.id === activeTool) ?? WORKSPACE_TOOLS[0];
  const ActiveLayout = active.layout[ctx.experience];

  return (
    <div
      data-testid="workspace-shell"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40"
    >
      <div data-testid="workspace-tool-content" className="min-h-0 flex-1 overflow-hidden">
        <ActiveLayout ctx={ctx} />
      </div>
      <div
        data-testid="workspace-tool-bar"
        className="pointer-events-none absolute inset-x-0 bottom-[var(--sf-space-3)] z-10 flex justify-center px-4"
      >
        <div
          role="tablist"
          aria-label="Workspace tools"
          className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background px-1.5 py-1.5 shadow-lg"
        >
          {WORKSPACE_TOOLS.map((tool) => {
            const available = tool.availability(ctx);
            const Icon = tool.icon;
            const isActive = tool.id === activeTool;
            return (
              <button
                key={tool.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                disabled={!available}
                data-testid={`workspace-tool-${tool.id}`}
                onClick={() => ctx.onToolChange(tool.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  !available && 'cursor-not-allowed opacity-40',
                )}
              >
                <Icon className="size-3.5" />
                {tool.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `cd web && npx vitest run src/session-first/workspace/__tests__/integration/WorkspaceShell.test.tsx && npx tsc --noEmit`
Expected: PASS (4 tests); tsc 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/session-first/workspace/
git commit -m "feat: workspace shell — bottom floating tool bar, ground tier (#561)"
```

---

### Task 3: Wire WorkspaceShell into the surface slot (replace WorkspacePanel)

**Files:**
- Modify: `web/src/session-first/SessionFirstMain.tsx`
- Modify: `web/src/session-first/SessionFirstWorkspace.tsx`
- Modify: `web/src/session-first/useSessionFirstShellState.ts`

- [ ] **Step 1: Replace the inline WorkspacePanel with WorkspaceShell**

In `web/src/session-first/SessionFirstMain.tsx`, delete the local `WorkspacePanel` function and render:

```tsx
      {showWorkspace ? (
        <div className={cn('min-h-0 flex-1', surface !== 'workspace' && 'hidden')}>
          <WorkspaceShell
            ctx={{
              session: selectedSession,
              agent: selectedAgent,
              domain,
              fileOps,
              experience: 'web',
              onToolChange,
            }}
            activeTool={tool}
          />
        </div>
      ) : null}
```

- Add `import { WorkspaceShell } from '@/session-first/workspace/WorkspaceShell';`
- `WorkspaceNavigation` and `WorkspaceToolId` imports become unused in this file — remove them. `WorkspaceToolId` still needs exporting somewhere: re-export from `@/session-first/workspace/toolTypes` for existing importers (`useSessionFirstShellState`, tests). Add to the toolTypes re-export in `tools/index.ts` and update the import in `SessionFirstMain.tsx` consumers to `import type { WorkspaceToolId } from '@/session-first/workspace/toolTypes';`.

- [ ] **Step 2: Verify no other importer breaks**

Run: `grep -rn "WorkspaceNavigation\|WorkspaceToolId" web/src --include="*.tsx" --include="*.ts" | grep -v workspace/`
Expected: only `useSessionFirstShellState.ts` and tests reference `WorkspaceToolId` (via the re-export) — update those imports to `@/session-first/workspace/toolTypes`.

- [ ] **Step 3: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ src/__tests__/integration/App.sessionFirst.test.tsx`
Expected: 0 errors; PASS. (SessionFirstMain tests may assert WorkspaceNavigation testids — update them to the new `workspace-shell` / `workspace-tool-bar` structure.)

- [ ] **Step 4: Commit**

```bash
git add web/src/session-first/
git commit -m "feat: workspace shell in the surface slot (#561)"
```

---

### Task 4: Files tool — grid web layout + push app layout, converged chrome

**Files:**
- Modify: `web/src/session-first/workspace/tools/files.tsx`
- Create: `web/src/session-first/workspace/tools/filesWeb.tsx`
- Create: `web/src/session-first/workspace/tools/filesApp.tsx`
- Modify: `web/src/session-first/patterns/FileWorkspace.tsx`
- Modify: `web/src/components/FileBrowser.tsx` (tool bar quiet pass)
- Modify: `web/src/components/FileViewer.tsx` (title bar quiet pass)

- [ ] **Step 1: Split FileWorkspace into the two plugin layouts**

Create `filesWeb.tsx`:

```tsx
// web/src/session-first/workspace/tools/filesWeb.tsx
import { useState } from 'react';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/** Web layout: tree ‖ editor on a CSS grid — proportions, no fixed px. */
export function FilesWebLayout({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  if (!ctx.fileOps) return null;
  return (
    <div data-testid="files-web-layout" className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] overflow-hidden">
      <div className="min-h-0 overflow-hidden border-r border-border/60">
        <FileBrowser
          fileOps={ctx.fileOps}
          onFileClick={(entry: FileEntry) => setSelected({ path: entry.path, filename: entry.name, size: entry.size })}
        />
      </div>
      <div className="min-h-0 overflow-hidden">
        {selected ? (
          <FileViewer key={selected.path} fileOps={ctx.fileOps} path={selected.path} filename={selected.filename} fileSize={selected.size} onClose={() => setSelected(null)} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file</div>
        )}
      </div>
    </div>
  );
}
```

Create `filesApp.tsx` (tree full-screen → push editor on select; keep it minimal — the App canonical screen is Phase 2C):

```tsx
// web/src/session-first/workspace/tools/filesApp.tsx
import { useState } from 'react';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import type { FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/** App layout: tree full-screen, editor pushed on select (2C refines this). */
export function FilesAppLayout({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  if (!ctx.fileOps) return null;
  if (selected) {
    return (
      <FileViewer key={selected.path} fileOps={ctx.fileOps} path={selected.path} filename={selected.filename} fileSize={selected.size} onClose={() => setSelected(null)} />
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden" data-testid="files-app-layout">
      <FileBrowser fileOps={ctx.fileOps} onFileClick={(entry: FileEntry) => setSelected({ path: entry.path, filename: entry.name, size: entry.size })} />
    </div>
  );
}
```

Update `files.tsx` to use them:

```tsx
import { FileText } from 'lucide-react';
import type { WorkspaceTool } from '../toolTypes';
import { FilesWebLayout } from './filesWeb';
import { FilesAppLayout } from './filesApp';

export const filesTool: WorkspaceTool = {
  id: 'files',
  label: 'Files',
  icon: FileText,
  order: 10,
  availability: (ctx) => ctx.fileOps !== null,
  layout: { web: FilesWebLayout, app: FilesAppLayout },
};
```

- [ ] **Step 2: Quiet the FileBrowser / FileViewer chrome**

In `web/src/components/FileBrowser.tsx`, the toolbar block (search input + Create button row with `border-b`) — reduce to one compact quiet line: keep functionality, change the row classes to `flex items-center gap-1 px-2 py-1 border-b border-border/60` and the buttons to `variant="ghost" size="sm"` with `text-muted-foreground` (match the 2A quiet-action family; keep all testids and handlers identical). Same treatment in `FileViewer.tsx` header row: keep filename + Read-only badge + save, quiet the buttons (`variant="ghost" size="sm"`), keep `data-testid`s.

- [ ] **Step 3: Delete the old FileWorkspace pattern wrapper or repoint it**

`web/src/session-first/patterns/FileWorkspace.tsx` is now only used by tests and the (removed) WorkspacePanel. Repoint its implementation to render `FilesWebLayout` (keep the file + testids so existing tests pass), or delete it and update tests — pick the smaller diff: keep the file as a thin re-export of the web layout (`export const FileWorkspace = FilesWebLayout`) and delete its own logic.

- [ ] **Step 4: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ src/__tests__/integration/App.sessionFirst.test.tsx && npm run lint`
Expected: 0 errors; PASS; 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/
git commit -m "feat: files tool plugin — grid web layout, push app layout, quiet chrome (#561)"
```

---

### Task 5: AI-style shell — sessions drawer, single top row

**Files:**
- Create: `web/src/session-first/SessionDrawer.tsx`
- Modify: `web/src/session-first/patterns/SessionHeader.tsx` (drawer button + server micro-status)
- Modify: `web/src/session-first/SessionFirstWorkspace.tsx` (drawer instead of persistent sidebar)
- Modify: `web/src/hooks/useSessionFirstMobileNav.ts` (desktop: list hidden)
- Modify: `web/src/session-first/SessionFirstSidebar.tsx` (reuse inside the drawer)
- Test: `web/src/session-first/__tests__/integration/SessionDrawer.test.tsx`

- [ ] **Step 1: Adjust useSessionFirstMobileNav for the AI-style resting layout**

The desktop resting state must be full-bleed content (no list pane). Change the hook so `showList` is `false` when wide (drawer replaces it):

```ts
// web/src/hooks/useSessionFirstMobileNav.ts — replace the showList/showDetail lines:
  const showList = !isWide && mobilePane === 'list';
  const showDetail = isWide || (mobilePane === 'detail' && selectedId !== null);
```

Keep `openDetail` / `openList` (the drawer reuses `openList` semantics). Verify the existing hook test (`web/src/hooks/__tests__/integration/useSessionFirstMobileNav.test.ts`) and update the desktop expectations (showList was `true` when wide; now `false`).

- [ ] **Step 2: Write the drawer test**

```tsx
// web/src/session-first/__tests__/integration/SessionDrawer.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionDrawer } from '../SessionDrawer';

vi.mock('@/session-first/patterns/SessionList', () => ({
  SessionList: () => <div data-testid="mock-session-list" />,
}));

describe('SessionDrawer', () => {
  it('renders the sessions list when open', () => {
    render(<SessionDrawer open onClose={vi.fn()} sidebar={null} />);
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('mock-session-list')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    render(<SessionDrawer open={false} onClose={vi.fn()} sidebar={null} />);
    expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument();
  });

  it('closes on scrim click', () => {
    const onClose = vi.fn();
    render(<SessionDrawer open onClose={onClose} sidebar={null} />);
    screen.getByTestId('session-drawer-scrim').click();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Write SessionDrawer**

```tsx
// web/src/session-first/SessionDrawer.tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SessionDrawerProps {
  open: boolean;
  onClose: () => void;
  sidebar: ReactNode;
}

/** AI-style sessions drawer: left overlay with scrim, slides in over full-bleed content. */
export function SessionDrawer({ open, onClose, sidebar }: SessionDrawerProps) {
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-40 lg:z-30" data-testid="session-drawer">
      <button
        type="button"
        aria-label="Close sessions"
        data-testid="session-drawer-scrim"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <aside
        data-testid="session-drawer-panel"
        className={cn(
          'absolute inset-y-0 left-0 flex w-[min(20rem,90vw)] flex-col border-r border-border/60 bg-background shadow-xl',
          'animate-in slide-in-from-left duration-200',
        )}
      >
        {sidebar}
      </aside>
    </div>
  );
}
```

(The `animate-in slide-in-from-left` utilities come from `tw-animate-css`, already imported in `index.css`.)

- [ ] **Step 4: SessionHeader gains the drawer button + server status**

In `web/src/session-first/patterns/SessionHeader.tsx`:

- New props: `onOpenDrawer?: () => void;` and `serverStatus?: ConnectionStatus;` (import `ConnectionStatus` type from `@/types` — do NOT confuse with the pattern component).
- Row 1 becomes: `[≡ drawer button (ghost icon, `Menu` from lucide, shown when `onOpenDrawer`)]` + existing back button (mobile) + `h1` title.
- Row 2 right side: `[Terminal | Workspace]` stays; add before it a `server: {status}` micro-text span with `data-testid="server-connection"` (`text-agent-error` when `'disconnected'`, else `text-muted-foreground`) — moved from the sidebar footer (which disappears with the persistent sidebar).

```tsx
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <AgentContext agentLabel={agentLabel} state={state} onOpenAgent={onOpenAgent} />
          <ConnectionStatus state={state} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {serverStatus ? (
            <span
              data-testid="server-connection"
              className={cn(
                'font-mono text-xs',
                serverStatus === 'disconnected' ? 'text-agent-error' : 'text-muted-foreground',
              )}
            >
              server: {serverStatus}
            </span>
          ) : null}
          <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
        </div>
      </div>
```

- [ ] **Step 5: SessionFirstWorkspace renders the drawer**

Replace the persistent `<SessionFirstSidebar className={cn(!showList && 'hidden lg:flex')} ...>` with:

```tsx
      <SessionDrawer
        open={!isWide ? showList : showDrawer}
        onClose={() => setShowDrawer(false)}
        sidebar={
          <SessionFirstSidebar
            {...sidebarProps}
            onSelect={onSelect}
          />
        }
      />
      <main className="min-h-0 flex-1">
        {/* mainShared unchanged */}
      </main>
```

- `showDrawer` is new local state in `SessionFirstWorkspace` (`useState(false)`), exposed to the shell so the top-row `[≡]` can open it: pass `onOpenDrawer={() => setShowDrawer(true)}` down to `SessionFirstMain` → `SessionHeader`. Add `onOpenDrawer?: () => void` to `SessionFirstMainProps` and forward it.
- `SessionFirstSidebar` keeps its own `className` prop (the drawer panel wraps it); the sidebar's footer `server:` text is REMOVED (moved to SessionHeader) — update `SessionFirstSidebar` accordingly and its tests (grep `server-connection`).
- `showList`/`showDetail` logic: with the hook change, wide always shows detail; `showList` is mobile-only. Remove the `hidden lg:flex` classing from the main content.

- [ ] **Step 6: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ src/__tests__/integration/App.sessionFirst.test.tsx && npm run lint`
Expected: 0 errors; PASS; 0 warnings. (Update any test asserting a persistent visible sidebar on desktop, or `server-connection` in the sidebar footer.)

- [ ] **Step 7: Commit**

```bash
git add web/src/
git commit -m "feat: AI-style shell — sessions drawer, single top row with server status (#561)"
```

---

### Task 6: App experience — no Terminal|Workspace switcher

**Files:**
- Modify: `web/src/session-first/patterns/SessionHeader.tsx`
- Modify: `web/src/session-first/SessionFirstMain.tsx`
- Modify: `web/src/session-first/SessionFirstSpatialLayout.tsx`

- [ ] **Step 1: Thread `experience` to SessionHeader**

- `SessionHeader` gains `experience?: 'web' | 'app'` (default `'web'`); render `<SurfaceSwitcher>` only when `experience !== 'app'`:

```tsx
          {experience !== 'app' ? (
            <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
          ) : null}
```

- `SessionFirstMain` gains `experience?: Experience` and forwards it to `SessionHeader` (default `'web'`).
- `SessionFirstSpatialLayout` passes `experience="app"` in its `mainShared` → `SessionFirstMain` (check `SessionFirstSpatialLayout.tsx:34-60` and how `mainShared` flows; add `experience: 'app'` to the spread there).
- The App spatial shell (`AppSpatialShell.tsx`) routes through the spatial layout — verify by grep that it lands in the spatial path; if App can also render `SessionFirstMain` directly, pass `experience="app"` there too.

- [ ] **Step 2: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/ src/__tests__/integration/App.sessionFirst.test.tsx`
Expected: 0 errors; PASS. (Spatial tests may assert the switcher — update to assert its absence.)

- [ ] **Step 3: Commit**

```bash
git add web/src/
git commit -m "feat: app experience hides Terminal|Workspace switcher (#561)"
```

---

### Task 7: Fixture — workspace variant + drawer state

**Files:**
- Modify: `web/src/session-first/fixture/fixtureData.ts` (add a deterministic file tree)
- Create: `web/src/session-first/fixture/fixtureFiles.ts`
- Create: `web/src/session-first/fixture/FixtureWorkspace.tsx`
- Modify: `web/src/session-first/fixture/FixtureShell.tsx`
- Modify: `web/src/App.tsx` (route)
- Modify: `web/src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx`

- [ ] **Step 1: Deterministic file tree**

```ts
// web/src/session-first/fixture/fixtureFiles.ts
import type { FileEntry } from '@/services/fileOps';

/**
 * Deterministic project tree for the workspace fixture — mirrors a realistic
 * repo layout (docs/design + web/src flavor). Flat list with path/type/size.
 */
export const FIXTURE_FILES: FileEntry[] = [
  { path: 'docs/design', name: 'design', type: 'dir', size: 0 },
  { path: 'docs/design/visual-language.md', name: 'visual-language.md', type: 'file', size: 6124 },
  { path: 'docs/design/composition.md', name: 'composition.md', type: 'file', size: 3988 },
  { path: 'web/src', name: 'src', type: 'dir', size: 0 },
  { path: 'web/src/App.tsx', name: 'App.tsx', type: 'file', size: 2210 },
  { path: 'web/src/index.css', name: 'index.css', type: 'file', size: 4330 },
  { path: 'web/src/session-first', name: 'session-first', type: 'dir', size: 0 },
  { path: 'web/src/session-first/workspace', name: 'workspace', type: 'dir', size: 0 },
  { path: 'web/src/session-first/workspace/WorkspaceShell.tsx', name: 'WorkspaceShell.tsx', type: 'file', size: 3145 },
  { path: 'web/src/session-first/workspace/tools', name: 'tools', type: 'dir', size: 0 },
  { path: 'web/src/session-first/workspace/tools/files.tsx', name: 'files.tsx', type: 'file', size: 812 },
];
```

(Check `FileEntry`'s real shape in `web/src/services/fileOps.ts` — adjust fields if needed; the fixture browser needs whatever `FileBrowser` consumes.)

- [ ] **Step 2: FixtureWorkspace**

```tsx
// web/src/session-first/fixture/FixtureWorkspace.tsx
import { WorkspaceShell } from '@/session-first/workspace/WorkspaceShell';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';
import { FIXTURE_AGENTS, FIXTURE_SELECTED_ID, FIXTURE_SESSIONS } from '@/session-first/fixture/fixtureData';
import { mapDomainState } from '@/session-first/domainState';

/** Fixture fileOps stub: serves FIXTURE_FILES, no network. */
function fixtureFileOps() {
  // Minimal FileOps-shaped object for the fixture: FileBrowser calls
  // list/read — implement them against FIXTURE_FILES (see services/fileOps
  // for the interface). Non-filesystem calls (upload/delete) can no-op.
}

export function FixtureWorkspace() {
  const selectedSession = FIXTURE_SESSIONS.find((s) => s.session_id === FIXTURE_SELECTED_ID) ?? null;
  const selectedAgent = FIXTURE_AGENTS.find((a) => a.agent_id === selectedSession?.agent_id);
  const domain = selectedSession
    ? mapDomainState({ session: selectedSession, agent: selectedAgent, staleAgentIds: [], clientSessionId: FIXTURE_SELECTED_ID, attachInFlightId: null, attachFailedId: null })
    : null;
  const ctx: WorkspaceContext = {
    session: selectedSession,
    agent: selectedAgent,
    domain,
    fileOps: fixtureFileOps(),
    experience: 'web',
    onToolChange: () => {},
  };
  return (
    <div data-testid="session-first-shell" className="session-first-shell flex h-[100dvh] flex-col bg-background">
      <WorkspaceShell ctx={ctx} activeTool="files" />
    </div>
  );
}
```

(The fixture FileOps stub must satisfy `FileBrowser`'s calls — read `FileBrowser.tsx` / `fileOps.ts` for the exact methods (`list`, `read`, …) and implement minimal ones returning `FIXTURE_FILES`; upload/delete/etc. return rejected promises or no-op. This is the fiddliest part of the task — implement against the real interface, and keep the stub in `fixtureFileOps.ts` if it grows.)

- [ ] **Step 3: Route + FixtureShell wiring**

- `web/src/App.tsx`: add `{ path: '/fixture/workspace', element: <FixtureWorkspace /> }` to BOTH routers (module-scope const `fixtureWorkspaceRoute`, like 2A's `fixtureRoute`).
- `FixtureShell.tsx`: add a drawer-open state — render the `SessionDrawer` with the real `SessionFirstSidebar` built from fixture props, `open` by default (deterministic), so the drawer is part of the canonical fixture. Keep the terminal fixture's resting state as-is.

- [ ] **Step 4: Extend the FixtureShell tests**

Append to `web/src/session-first/fixture/__tests__/integration/FixtureShell.test.tsx`:

```tsx
  it('renders the sessions drawer deterministically', () => {
    render(<FixtureShell />);
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
    expect(screen.getAllByTestId('session-item-row')).toHaveLength(6);
  });
```

(And a new `FixtureWorkspace.test.tsx` asserting `workspace-shell` + `workspace-tool-bar` render — follow the same mock pattern as FixtureShell's test.)

- [ ] **Step 5: Gates**

Run: `cd web && npx tsc --noEmit && npx vitest run src/session-first/fixture && npm run lint`
Expected: 0 errors; PASS; 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/
git commit -m "feat: workspace fixture variant with deterministic file tree (#561)"
```

---

### Task 8: E2E — workspace canonical spec (CI-only)

**Files:**
- Create: `e2e/specs/fixture-workspace.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// e2e/specs/fixture-workspace.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

test('canonical Workspace fixture renders the plugin shell', async ({ page }) => {
  await page.goto('/#/fixture/workspace');

  await expect(page.getByTestId('session-first-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  // tool bar from the registry: Files / Session / Agent
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Session' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Agent' })).toBeVisible();

  // files web layout renders tree ‖ editor
  await expect(page.getByTestId('files-web-layout')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-workspace.png', fullPage: true });
});

test('sessions drawer opens from the resting shell', async ({ page }) => {
  await page.goto('/#/fixture');
  await expect(page.getByTestId('session-drawer')).toBeVisible();
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});
```

- [ ] **Step 2: Static verification only (no local run)**

Run: `cd e2e && npx playwright test --list` — discovers `fixture-workspace.spec.ts` (no webServers spawned).

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/fixture-workspace.spec.ts
git commit -m "test(e2e): canonical Workspace fixture spec at 1440×900, CI-only (#561)"
```

---

### Task 9: Docs sync

**Files:**
- Modify: `docs/design/composition.md`
- Modify: `docs/design/workspace.md`
- Modify: `docs/design/visual-language.md`

- [ ] **Step 1: composition.md — AI-style shell geometry**

- §1: resting shell = single top row (drawer button + session line + switcher + server status) + full-bleed Terminal; the persistent sidebar is gone (sessions live in a drawer overlay).
- §2 sidebar width strategy → drawer width strategy: `w-[min(20rem,90vw)]`, overlay + scrim, slide-in.
- §3 chrome height: top row only; workspace ground tier + bottom floating tool bar.
- Keep the measured chrome-budget note consistent (top row ≈ 60 px + capsule + tool bar when workspace is active).

- [ ] **Step 2: workspace.md — plugin contract**

- Tool registry section: the `WorkspaceTool` interface gains `layout: { web, app }` (per-experience layouts owned by the tool) and the no-fixed-px rule (grids/proportions only for structure); note the bottom floating tool bar as the workspace's only floating element.

- [ ] **Step 3: visual-language.md — surface hierarchy**

- §3 surface table: add the workspace ground tier (one step darker than canvas, `--muted` tier); the floating control surface now hosts both the terminal input capsule AND the workspace tool bar.
- R-S6 stays; the AI-style shell decision (drawer sessions) goes in composition.md, not here.

- [ ] **Step 4: Commit**

```bash
git add docs/design/
git commit -m "docs(design): sync composition/workspace/visual-language to workspace canonical screen (#561)"
```

---

### Task 10: Full gates + browser verification + screenshots

- [ ] **Step 1: Web gates**

Run: `cd web && npm run build && npm run lint && npx tsc --noEmit && npm test`
Expected: build success; lint 0 warnings; tsc 0 errors; all tests pass.

- [ ] **Step 2: Browser verification (vite dev only — no backend, no tmux)**

```bash
cd web && npm run dev   # :13000
```

Using a small Playwright script (pattern from 2A: chromium from `e2e/node_modules/playwright-core`):
1. `/#/fixture` at 1440×900 — resting AI-style shell: no persistent sidebar, drawer button visible, terminal full-bleed; drawer open state renders session rows.
2. `/#/fixture/workspace` at 1440×900 — `workspace-shell`, bottom `workspace-tool-bar` with 3 tabs, `files-web-layout` tree ‖ editor, no horizontal overflow.
3. Console: no errors (jotai atomFamily deprecation warning is pre-existing).
4. Screenshots → `.playwright-mcp/screenshots/canonical-workspace.png` + `canonical-shell.png`.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "fix: visual verification fixes for workspace canonical screen (#561)"
```
(Only if fixes were needed.)

---

### Task 11: Push, PR to staging, screenshots comment

- [ ] **Step 1: Verify branch and push**

```bash
git branch --show-current   # must be feat/web-workspace-canonical
git push -u origin feat/web-workspace-canonical
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --base staging --title "feat: Web Workspace canonical screen — plugin framework, AI-style shell (#561)" --body "$(cat <<'BODY'
## 变更内容

#561 Phase 2B — Web Workspace / Files canonical screen (1440×900):

- **Workspace 插件框架**:WorkspaceTool 契约(id/label/icon/order/availability + layout.web/app);注册表 + 底部浮动圆角工具条(capsule 同族);加工具 = 一个文件 + 一行注册
- **Files 工具插件化**:web 布局 = CSS grid 树(1fr)‖ 编辑器(2fr),app 布局 = 树全屏 → push 编辑器;FileBrowser/FileViewer chrome 收敛
- **AI 风壳**:常驻 sidebar → sessions 抽屉(遮罩 + 滑入);顶部唯一常驻行 = 抽屉按钮 + session 行 + [Terminal|Workspace] + server 微状态;Terminal 全屏
- **App**:不再渲染 [Terminal|Workspace] 切换(spatial 模型)
- **Fixture**:workspace 变体(确定性文件树 + 编辑器内容)+ 抽屉状态;e2e CI-only
- **docs 同步**:composition(抽屉化几何)、workspace(插件契约 + 布局约束)、visual-language(工作区地面层)

⚠️ 发布注意延续 2A:visual-language/composition 在 main 与 staging 内容冲突(超集,取本分支);workspace.md 也随 2B 更新。

## 测试报告

- `npm run build` / `npm run lint` / `npx tsc --noEmit`:全绿
- `npm test`:全部通过(含 registry / WorkspaceShell / SessionDrawer / fixture 新测试)
- e2e fixture-workspace + fixture-canonical:CI-only,`--list` 验证,CI 由 e2e.yml 跑
- 浏览器验证(1440×900, vite dev 无后端):resting shell / 抽屉 / workspace 浮条 + files 布局,console 干净;截图见 PR comment

Note:#561 Phase 2B — 无 `Closes`(进 release PR)
BODY
)"
```

- [ ] **Step 3: Post screenshots**

```bash
gh pr comment <PR-NUMBER> --body "## Canonical screens (1440×900)

![workspace](.playwright-mcp/screenshots/canonical-workspace.png)

![shell](.playwright-mcp/screenshots/canonical-shell.png)"
```

- [ ] **Step 4: Auto-merge**

```bash
gh pr merge <PR-NUMBER> --auto --merge
```

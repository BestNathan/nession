# Session-first Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a flag-gated Web Session-first shell that completes Session list → Terminal → Workspace → Files → Editor → Agent detail → Terminal without changing the server or replacing the legacy Dashboard.

**Architecture:** Client-only. `isSessionFirst()` swaps `App` between `Dashboard` and `SessionFirstShell`. New chrome lives under `web/src/session-first/`. Attach/P2P/xterm reuse existing atoms, `resolveDeepLinkAttachChoice`, `useP2PConnection`, `useTerminal`, and `TerminalPane`. Files reuse `FileBrowser`/`FileViewer`. Domain channels are a pure mapper over today’s `Agent.status` / `Session.status` / client attach atoms. No `crates/` edits. No `TerminalWorkspace` / `TerminalLayout` / shipping `SessionList.tsx` / `AgentDetailPanel` in the slice.

**Tech Stack:** React 18, hash router, jotai, Tailwind v4, shadcn Tabs/Button/ScrollArea, Vitest + Testing Library, Playwright MCP for the PR.

**Spec:** `docs/superpowers/specs/2026-08-27-session-first-vertical-slice-design.md`  
**Issue:** #471  
**Worktree:** `.claude/worktrees/feat-session-first-slice` on `feat/session-first-slice`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `web/src/lib/sessionFirst.ts` | Query + `localStorage` flag |
| `web/src/lib/__tests__/unit/sessionFirst.test.ts` | Flag tests (`@vitest-environment jsdom`) |
| `web/src/session-first/domainState.ts` | Wire → three channels + copy |
| `web/src/session-first/__tests__/unit/domainState.test.ts` | Mapper tests |
| `web/src/index.css` | `--agent-*` / `--session-*` / `--attachment-*` + `@theme` colors |
| `web/src/session-first/patterns/ConnectionStatus.tsx` | Three labeled channels |
| `web/src/session-first/patterns/SessionItem.tsx` | Flat row |
| `web/src/session-first/patterns/SessionList.tsx` | Flat list + empty |
| `web/src/session-first/patterns/AgentContext.tsx` | Quiet/prominent Agent chrome |
| `web/src/session-first/patterns/SessionHeader.tsx` | Title + context + switcher slot |
| `web/src/session-first/patterns/SurfaceSwitcher.tsx` | Terminal \| Workspace |
| `web/src/session-first/patterns/WorkspaceNavigation.tsx` | Files \| Session \| Agent |
| `web/src/session-first/patterns/AgentDetail.tsx` | New Agent tool (not AgentDetailPanel) |
| `web/src/session-first/patterns/FileWorkspace.tsx` | Browser + viewer split |
| `web/src/session-first/SessionDetails.tsx` | Session tool facts |
| `web/src/session-first/SessionFirstTerminal.tsx` | xterm keep-alive (no Files split) |
| `web/src/session-first/SessionFirstShell.tsx` | Layout, data, attach |
| `web/src/hooks/useSessionFirstAttach.ts` | Auto attach via `resolveDeepLinkAttachChoice` |
| `web/src/session-first/__tests__/integration/*.tsx` | Pattern + shell tests |
| `web/src/App.tsx` | Swap shells; flag-on router still has `/` + `/terminal/:sessionId` |
| `web/src/__tests__/integration/App.sessionFirst.test.tsx` | Flag → which shell |
| `web/src/components/DashboardHeader.tsx` | “Session-first” toggle when flag off |

**Do not modify:** `crates/**`, `TerminalWorkspace.tsx`, `TerminalLayout.tsx`, `components/SessionList.tsx`, `AgentDetailPanel.tsx`, protocol.

**Commands (all from `web/` unless noted):**

```bash
npx vitest run src/lib/__tests__/unit/sessionFirst.test.ts
npx vitest run src/session-first/__tests__/unit/domainState.test.ts
npx vitest run src/session-first/__tests__/integration
npx vitest run src/__tests__/integration/App.sessionFirst.test.ts
npx tsc --noEmit
npm run lint
```

Commit from worktree root. Co-author: `Co-Authored-By: Claude <noreply@anthropic.com>`

---

### Task 1: session_first flag

**Files:**
- Create: `web/src/lib/sessionFirst.ts`
- Test: `web/src/lib/__tests__/unit/sessionFirst.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSessionFirst, setSessionFirst } from '@/lib/sessionFirst';

const KEY = 'nession_session_first';

describe('sessionFirst', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('defaults off when query and storage are empty', () => {
    expect(isSessionFirst()).toBe(false);
  });

  it('reads localStorage 1', () => {
    localStorage.setItem(KEY, '1');
    expect(isSessionFirst()).toBe(true);
  });

  it('query session_first=1 wins and writes storage', () => {
    window.history.replaceState({}, '', '/?session_first=1');
    expect(isSessionFirst()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('query session_first=0 forces legacy and writes storage', () => {
    localStorage.setItem(KEY, '1');
    window.history.replaceState({}, '', '/?session_first=0');
    expect(isSessionFirst()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  it('setSessionFirst writes storage', () => {
    setSessionFirst(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(isSessionFirst()).toBe(true);
    setSessionFirst(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(isSessionFirst()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npx vitest run src/lib/__tests__/unit/sessionFirst.test.ts
```

Expected: FAIL — cannot find module `@/lib/sessionFirst`.

- [ ] **Step 3: Write minimal implementation**

```ts
const KEY = 'nession_session_first';

function readQuery(): '1' | '0' | null {
  const v = new URLSearchParams(window.location.search).get('session_first');
  if (v === '1' || v === '0') {
    return v;
  }
  return null;
}

export function isSessionFirst(): boolean {
  const q = readQuery();
  if (q !== null) {
    localStorage.setItem(KEY, q);
    return q === '1';
  }
  return localStorage.getItem(KEY) === '1';
}

export function setSessionFirst(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0');
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

```bash
cd web && npx vitest run src/lib/__tests__/unit/sessionFirst.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/sessionFirst.ts web/src/lib/__tests__/unit/sessionFirst.test.ts
git commit -m "$(cat <<'EOF'
feat: add session_first client flag

Query session_first=1|0 wins and persists to localStorage; default off
so the Session-first slice is not a production cutover.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Domain-state mapper

**Files:**
- Create: `web/src/session-first/domainState.ts`
- Test: `web/src/session-first/__tests__/unit/domainState.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import type { Agent, Session } from '@/types';
import { mapDomainState } from '@/session-first/domainState';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1', hostname: 'devbox-01', ip_address: '10.0.0.1', port: 1,
    status: 'online', session_count: 1, last_heartbeat: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    session_id: 'a1:s1', agent_id: 'a1', session_name: 's1', status: 'active',
    window_count: 1, attached_clients: 0, last_activity: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('mapDomainState', () => {
  it('maps online agent + unmatched row to quiet agent, active session, detached', () => {
    const d = mapDomainState({
      session: session(), agent: agent(), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('online');
    expect(d.agent.copy).toBeNull();
    expect(d.session.channel).toBe('active');
    expect(d.attachment.channel).toBe('detached');
  });

  it('maps wire detached to session.active (tmux still exists)', () => {
    const d = mapDomainState({
      session: session({ status: 'detached' }), agent: agent(), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.session.channel).toBe('active');
  });

  it('maps zombie to session.exited', () => {
    const d = mapDomainState({
      session: session({ status: 'zombie' }), agent: agent(), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.session.channel).toBe('exited');
  });

  it('maps offline agent with listed session — Agent copy, not Session offline', () => {
    const d = mapDomainState({
      session: session(), agent: agent({ status: 'offline' }), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('offline');
    expect(d.agent.copy).toMatch(/Agent (offline|unreachable)/);
    expect(d.session.channel).toBe('active');
    expect(d.agent.copy).not.toMatch(/Session offline/i);
  });

  it('stale_agents marks unhealthy even when agent.status is online', () => {
    const d = mapDomainState({
      session: session(), agent: agent({ status: 'online' }), staleAgentIds: ['a1'],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.copy).toBe('Agent did not respond');
    expect(d.session.channel).toBe('active');
  });

  it('degraded maps to agent.error', () => {
    const d = mapDomainState({
      session: session(), agent: agent({ status: 'degraded' }), staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('error');
    expect(d.agent.copy).toBe('Agent error');
  });

  it('missing agent → unreachable + session.unknown', () => {
    const d = mapDomainState({
      session: session(), agent: undefined, staleAgentIds: [],
      clientSessionId: '', attachInFlightId: null, attachFailedId: null,
    });
    expect(d.agent.channel).toBe('offline');
    expect(d.session.channel).toBe('unknown');
  });

  it('this-client attached / attaching / failed', () => {
    const base = {
      session: session(), agent: agent(), staleAgentIds: [] as string[],
    };
    expect(mapDomainState({
      ...base, clientSessionId: 'a1:s1', attachInFlightId: null, attachFailedId: null,
    }).attachment.channel).toBe('attached');
    expect(mapDomainState({
      ...base, clientSessionId: '', attachInFlightId: 'a1:s1', attachFailedId: null,
    }).attachment.channel).toBe('attaching');
    expect(mapDomainState({
      ...base, clientSessionId: '', attachInFlightId: null, attachFailedId: 'a1:s1',
    }).attachment.channel).toBe('failed');
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
cd web && npx vitest run src/session-first/__tests__/unit/domainState.test.ts
```

- [ ] **Step 3: Implement**

```ts
import type { Agent, Session } from '../types';

export type AgentChannel = 'online' | 'offline' | 'error';
export type SessionChannel = 'active' | 'exited' | 'unknown';
export type AttachmentChannel = 'attached' | 'attaching' | 'detached' | 'failed';

export interface ChannelView<C extends string> {
  channel: C;
  copy: string | null;
}

export interface DomainState {
  agent: ChannelView<AgentChannel>;
  session: ChannelView<SessionChannel>;
  attachment: ChannelView<AttachmentChannel>;
}

export interface MapDomainStateInput {
  session: Session;
  agent: Agent | undefined;
  staleAgentIds: Iterable<string>;
  clientSessionId: string;
  attachInFlightId: string | null;
  attachFailedId: string | null;
}

export function mapDomainState(input: MapDomainStateInput): DomainState {
  const stale = new Set(input.staleAgentIds);
  const sid = input.session.session_id;

  let agentChannel: AgentChannel = 'offline';
  let agentCopy: string | null = 'Agent unreachable';
  if (input.agent) {
    if (stale.has(input.agent.agent_id)) {
      agentChannel = input.agent.status === 'offline' ? 'offline' : 'error';
      agentCopy = 'Agent did not respond';
    } else if (input.agent.status === 'online') {
      agentChannel = 'online';
      agentCopy = null;
    } else if (input.agent.status === 'offline') {
      agentChannel = 'offline';
      agentCopy = 'Agent offline';
    } else {
      agentChannel = 'error';
      agentCopy = 'Agent error';
    }
  }

  let sessionChannel: SessionChannel = 'unknown';
  if (input.agent) {
    sessionChannel = input.session.status === 'zombie' ? 'exited' : 'active';
  }

  let attachment: AttachmentChannel = 'detached';
  if (input.attachFailedId === sid) {
    attachment = 'failed';
  } else if (input.attachInFlightId === sid) {
    attachment = 'attaching';
  } else if (input.clientSessionId === sid) {
    attachment = 'attached';
  }

  return {
    agent: { channel: agentChannel, copy: agentCopy },
    session: { channel: sessionChannel, copy: null },
    attachment: {
      channel: attachment,
      copy: attachment === 'failed' ? 'Attach failed' : null,
    },
  };
}
```

- [ ] **Step 4: Re-run — expect PASS**

- [ ] **Step 5: Commit** `feat: map wire agent/session status to three UI channels`

---

### Task 3: Slice domain tokens in CSS

**Files:**
- Modify: `web/src/index.css`

No unit test (CSS). Verify with `cd web && npx tsc --noEmit`.

- [ ] **Step 1: Add `@theme inline` color aliases** (after existing `--color-*` entries, around line 48):

```css
  --color-agent-online: var(--agent-online);
  --color-agent-offline: var(--agent-offline);
  --color-agent-error: var(--agent-error);
  --color-session-active: var(--session-active);
  --color-session-exited: var(--session-exited);
  --color-attachment-attached: var(--attachment-attached);
  --color-attachment-failed: var(--attachment-failed);
```

- [ ] **Step 2: Add values in `:root` before the closing `}` of `:root`:**

```css
  --agent-online: oklch(0.63 0.17 145);
  --agent-offline: var(--muted-foreground);
  --agent-error: var(--destructive);
  --session-active: var(--foreground);
  --session-exited: var(--muted-foreground);
  --attachment-attached: var(--agent-online);
  --attachment-failed: var(--destructive);
```

- [ ] **Step 3: Duplicate the same seven variables inside `.dark`**, mapping error/failed to `var(--destructive)` and online to `oklch(0.72 0.17 145)`.

TSX in later tasks uses `text-agent-online`, `bg-agent-offline/20`, `border-agent-error` — never `bg-green-500`.

- [ ] **Step 4: Commit** `feat: add session-first domain color tokens`

---

### Task 4: ConnectionStatus

**Files:**
- Create: `web/src/session-first/patterns/ConnectionStatus.tsx`
- Test: `web/src/session-first/__tests__/integration/ConnectionStatus.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import type { DomainState } from '@/session-first/domainState';

const state: DomainState = {
  agent: { channel: 'offline', copy: 'Agent offline' },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'failed', copy: 'Attach failed' },
};

describe('ConnectionStatus', () => {
  it('renders three labeled channels and does not say Session offline', () => {
    render(<ConnectionStatus state={state} />);
    expect(screen.getByTestId('channel-agent')).toHaveTextContent(/Agent/);
    expect(screen.getByTestId('channel-agent')).toHaveTextContent(/offline/i);
    expect(screen.getByTestId('channel-session')).toHaveTextContent(/Session/);
    expect(screen.getByTestId('channel-attachment')).toHaveTextContent(/Attach failed/);
    expect(screen.queryByText(/Session offline/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd web && npx vitest run src/session-first/__tests__/integration/ConnectionStatus.test.tsx
```

- [ ] **Step 3: Implement** — three `span`s with `data-testid="channel-agent|session|attachment"`. Color value text with `text-agent-offline` / `text-session-active` / `text-attachment-failed` (switch on `state.*.channel`). Labels: `Agent`, `Session`, `This client`. Show `copy` when non-null, else the channel name.

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit** `feat: add ConnectionStatus pattern with three channels`

---

### Task 5: SessionList + SessionItem

**Files:**
- Create: `web/src/session-first/patterns/SessionItem.tsx`
- Create: `web/src/session-first/patterns/SessionList.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionList.test.tsx`

Use `agentDisplayName` from `@/lib/format` and `formatRelativeTime` for recency. Workload literal `'shell'`.

- [ ] **Step 1: Failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from '@/session-first/patterns/SessionList';
import type { Agent, Session } from '@/types';

const agent: Agent = {
  agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
  ip_address: '10.0.0.1', port: 1, status: 'offline', session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};
const sess: Session = {
  session_id: 'a1:fix', agent_id: 'a1', session_name: 'Fix terminal reconnect',
  status: 'active', window_count: 1, attached_clients: 0,
  last_activity: new Date().toISOString(),
};

describe('SessionList', () => {
  it('shows empty copy about Sessions', () => {
    render(
      <SessionList
        sessions={[]} agents={[]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" attachInFlightId={null} attachFailedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/No sessions/i)).toBeInTheDocument();
  });

  it('lists a session while Agent is offline with Agent copy, not Session offline', async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[sess]} agents={[agent]} staleAgentIds={[]} selectedId={null}
        clientSessionId="" attachInFlightId={null} attachFailedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.getByText(/shell/)).toBeInTheDocument();
    expect(screen.getByText(/devbox-01/)).toBeInTheDocument();
    expect(screen.getByText(/Agent offline/)).toBeInTheDocument();
    expect(screen.queryByText(/Session offline/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(onSelect).toHaveBeenCalledWith(sess);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `SessionItem`** — button/row `data-testid={`session-item-${session.session_id}`}` (colon is fine in testid). Name primary. Metadata: `shell · {agentDisplayName} · {formatRelativeTime}`. If `domain.agent.copy`, show it with `text-agent-offline` / `text-agent-error`. Selected: `bg-accent`. **No** `bg-green-500` dots.

**SessionList:** `ScrollArea`; map sessions (do **not** filter by agent online). Empty: “No sessions”. `agents` as `Map`/`find` by `agent_id`. Call `mapDomainState` per row.

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit** `feat: add Session-first list with Agent reachability copy`

---

### Task 6: Header chrome (AgentContext, SurfaceSwitcher, SessionHeader)

**Files:**
- Create: `web/src/session-first/patterns/AgentContext.tsx`
- Create: `web/src/session-first/patterns/SurfaceSwitcher.tsx`
- Create: `web/src/session-first/patterns/SessionHeader.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionHeader.test.tsx`

- [ ] **Step 1: Tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionHeader } from '@/session-first/patterns/SessionHeader';
import type { DomainState } from '@/session-first/domainState';

const healthy: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'attached', copy: null },
};
const offline: DomainState = {
  ...healthy,
  agent: { channel: 'offline', copy: 'Agent offline' },
};

describe('SessionHeader', () => {
  it('shows session name, quiet agent identity, and surface switcher', async () => {
    const onSurface = vi.fn();
    render(
      <SessionHeader
        sessionName="Fix terminal reconnect"
        agentLabel="devbox-01"
        state={healthy}
        surface="terminal"
        onSurfaceChange={onSurface}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(screen.getByText('Fix terminal reconnect')).toBeInTheDocument();
    expect(screen.getByTestId('agent-context')).toHaveTextContent('devbox-01');
    expect(screen.queryByText('Agent offline')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    expect(onSurface).toHaveBeenCalledWith('workspace');
  });

  it('makes AgentContext prominent when offline', () => {
    render(
      <SessionHeader
        sessionName="s"
        agentLabel="devbox-01"
        state={offline}
        surface="terminal"
        onSurfaceChange={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );
    expect(screen.getByTestId('agent-context')).toHaveTextContent('Agent offline');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

`SurfaceSwitcher`: shadcn `Tabs` with two triggers `Terminal` and `Workspace`. `value={surface}` `onValueChange`. `data-testid="surface-switcher"`.

`AgentContext`: `data-testid="agent-context"`. If `state.agent.channel === 'online'` show only `agentLabel` with `text-muted-foreground`. Else show copy with `text-agent-offline` or `text-agent-error`. Click calls `onOpenAgent`.

`SessionHeader`: flex row — title, `AgentContext`, compact `ConnectionStatus`, `SurfaceSwitcher`.

- [ ] **Step 4: PASS + commit** `feat: add SessionHeader with surface switcher`

---

### Task 7: WorkspaceNavigation, SessionDetails, AgentDetail

**Files:**
- Create: `web/src/session-first/patterns/WorkspaceNavigation.tsx`
- Create: `web/src/session-first/SessionDetails.tsx`
- Create: `web/src/session-first/patterns/AgentDetail.tsx`
- Test: `web/src/session-first/__tests__/integration/WorkspaceTools.test.tsx`

- [ ] **Step 1: Tests** — assert Files/Session/Agent tabs; AgentDetail shows identity + `ConnectionStatus` and **does not** import/render `AgentDetailPanel` (query `Copy Agent details` / heartbeat “Healthy” pills from the legacy panel — those strings must be absent). SessionDetails shows session name and id.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceNavigation } from '@/session-first/patterns/WorkspaceNavigation';
import { AgentDetail } from '@/session-first/patterns/AgentDetail';
import { SessionDetails } from '@/session-first/SessionDetails';
import type { Agent, Session } from '@/types';
import type { DomainState } from '@/session-first/domainState';

const state: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

describe('Workspace tools', () => {
  it('switches Files / Session / Agent', async () => {
    const onTool = vi.fn();
    render(
      <WorkspaceNavigation tool="files" onToolChange={onTool} filesAvailable />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(onTool).toHaveBeenCalledWith('agent');
  });

  it('hides Files when unavailable', () => {
    render(
      <WorkspaceNavigation tool="session" onToolChange={vi.fn()} filesAvailable={false} />,
    );
    expect(screen.queryByRole('tab', { name: 'Files' })).not.toBeInTheDocument();
  });

  it('AgentDetail is not AgentDetailPanel', () => {
    const agent: Agent = {
      agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
      ip_address: '10.0.0.1', port: 19091, status: 'online', session_count: 1,
      last_heartbeat: '2026-01-01T00:00:00Z',
    };
    render(<AgentDetail agent={agent} state={state} />);
    expect(screen.getByTestId('agent-detail')).toHaveTextContent('devbox-01');
    expect(screen.getByTestId('channel-agent')).toBeInTheDocument();
    expect(screen.queryByText(/Copy Agent details/i)).not.toBeInTheDocument();
  });

  it('SessionDetails shows facts', () => {
    const session: Session = {
      session_id: 'a1:s1', agent_id: 'a1', session_name: 's1', status: 'active',
      window_count: 2, attached_clients: 0, last_activity: '2026-01-01T00:00:00Z',
    };
    render(<SessionDetails session={session} state={state} />);
    expect(screen.getByText('s1')).toBeInTheDocument();
    expect(screen.getByText('a1:s1')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2–4: Implement with shadcn Tabs.** `export type WorkspaceToolId = 'files' | 'session' | 'agent'`. AgentDetail: name, hostname, id, ip:port, versions from `metadata` if present, `ConnectionStatus`. Single column. No session switcher list.

- [ ] **Step 5: Commit** `feat: add Workspace tool navigation and AgentDetail`

---

### Task 8: FileWorkspace

**Files:**
- Create: `web/src/session-first/patterns/FileWorkspace.tsx`
- Test: `web/src/session-first/__tests__/integration/FileWorkspace.test.tsx`

Reuse `FileBrowser` and `FileViewer`. Detached: empty state, do not render `FileBrowser`.

- [ ] **Step 1: Test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';
import type { FileOps, FileEntry } from '@/services/fileOps';

const FILE: FileEntry = {
  name: 'f.txt', path: 'f.txt', full_path: '/root/f.txt', is_dir: false, size: 5, modified: 0,
};

function makeFileOps(): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [FILE] }),
    readFile: vi.fn().mockResolvedValue({ path: '/f.txt', content: btoa('hello'), mime_type: 'text/plain' }),
    writeFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '/f.txt', success: true }),
    createDir: vi.fn().mockResolvedValue({ path: '/d', success: true }),
    renameFile: vi.fn().mockResolvedValue({ from: '/a', to: '/b', success: true }),
    uploadFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  } as unknown as FileOps;
}

describe('FileWorkspace', () => {
  it('shows attach-first empty state when fileOps is null', () => {
    render(<FileWorkspace fileOps={null} />);
    expect(screen.getByText(/attach/i)).toBeInTheDocument();
    expect(screen.queryByText('f.txt')).not.toBeInTheDocument();
  });

  it('opens a file in the detail pane', async () => {
    render(<FileWorkspace fileOps={makeFileOps()} />);
    await userEvent.click(await screen.findByText('f.txt'));
    expect(await screen.findByText('f.txt')).toBeInTheDocument();
  });
});
```

The second assertion: after click, `FileViewer` toolbar shows filename. If `FileViewer` needs extra providers, wrap with whatever `FileBrowser.test.tsx` uses (none). Mock `sonner` like FileBrowser tests.

- [ ] **Step 2: FAIL, then implement** — `grid grid-cols-2` (or flex) `data-testid="file-workspace"`: left `FileBrowser`, right `FileViewer` or empty “Select a file”. `onFileClick` sets local `{ path, filename, size }`.

- [ ] **Step 3: PASS + commit** `feat: add Files tool master/detail workspace`

---

### Task 9: SessionFirstTerminal (keep-alive, no Files split)

**Files:**
- Create: `web/src/session-first/SessionFirstTerminal.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionFirstTerminal.test.tsx`

Copy the **runtime** from `web/src/terminal/components/TerminalWorkspace.tsx` (atoms, `useAddressPlan`, `useP2PConnection`, `useTerminalStateMachine`, `useTerminal`, `ConnectionManager`, `TerminalPane`, relay lost, banners, `flushAllOutbound`). **Omit** `TerminalHeader`, `SessionPreviewDialog`, `TerminalLayout`, `useTerminalSessions`.

Props: `{ hidden: boolean; onDisconnect: () => void; onError: (e: Error) => void }`.

- [ ] **Step 1: Test with mocked child** — easiest reliable test: export a wrapper that always renders `data-testid="session-first-terminal"` and toggles `hidden`:

If full hook stack is too heavy in jsdom, mock:

```tsx
vi.mock('@/hooks/useP2PConnection', () => ({ useP2PConnection: () => {} }));
vi.mock('@/hooks/useAddressPlan', () => ({
  useAddressPlan: () => ({ ready: true, urls: [] }),
}));
vi.mock('@/terminal/hooks/useTerminalStateMachine', () => ({
  useTerminalStateMachine: () => ({ terminalState: 'idle', reconnectCount: 0 }),
}));
vi.mock('@/terminal/hooks/useTerminal', () => ({ useTerminal: () => null }));
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ onConnectionChange: () => () => {}, isConnected: () => false, endRelay: vi.fn() }),
}));
```

Wrap in `Provider` from jotai. Assert:

```tsx
const { rerender } = render(<SessionFirstTerminal hidden={false} onDisconnect={vi.fn()} onError={vi.fn()} />);
const el = screen.getByTestId('session-first-terminal');
expect(el.className).not.toMatch(/\bhidden\b/);
rerender(<SessionFirstTerminal hidden onDisconnect={vi.fn()} onError={vi.fn()} />);
expect(screen.getByTestId('session-first-terminal').className).toMatch(/\bhidden\b/);
```

- [ ] **Step 2–4: Implement.** Outer: `className={cn('flex-1 min-h-0 flex flex-col', hidden && 'hidden')}`. Never unmount `TerminalPane` when `hidden` flips. If `sessionIdAtom` is empty, render a muted “Select a session” empty state **inside** the same testid node (still keep-alive structure).

- [ ] **Step 5: Commit** `feat: add Session-first terminal surface without Files split`

---

### Task 10: SessionFirstShell + auto attach

**Files:**
- Create: `web/src/hooks/useSessionFirstAttach.ts`
- Create: `web/src/session-first/SessionFirstShell.tsx`
- Test: `web/src/session-first/__tests__/integration/SessionFirstShell.test.tsx`

**Attach:** On `SessionItem` select, set `attachInFlightId`, call `resolveDeepLinkAttachChoice(ws, session, probeResults)` then `store.set(attachToSessionAtom, { session, choice, navigate })`. On throw, set `attachFailedId` to that session id (clear in-flight). `navigate` is react-router `navigate` so `/terminal/:id` stays on this shell (Task 11 registers that route).

Also call `useDashboard()` for agents/sessions (do **not** apply Dashboard online-only session filter — use `sessionData.sessions` / `agents`, not `filteredSessions` with statusFilter). Use `useProbePolling(agents)` like Dashboard. `staleAgents` from dashboard state.

Surface state: `useState<'terminal' | 'workspace'>('terminal')`. Selecting a session sets surface to `'terminal'`. `onOpenAgent` sets surface workspace + tool `agent`.

Flag control: button `data-testid="use-legacy-dashboard"` → `setSessionFirst(false)` + `onLegacy()`.

- [ ] **Step 1: Shell tests with mocked `useDashboard` / terminal / files**

```tsx
vi.mock('@/hooks/useDashboard', () => ({
  useDashboard: () => ({
    agents: [/* offline agent */],
    sessions: [/* session on that agent */],
    staleAgents: [],
    loadingSessions: false,
    sessionsLoaded: true,
    error: null,
    fetchSessions: vi.fn(),
    clearError: vi.fn(),
  }),
}));
```

Mock `useProbePolling` as no-op. Mock `SessionFirstTerminal` as `<div data-testid="session-first-terminal" />`. Mock `FileWorkspace` as `<div data-testid="file-workspace" />`.

Assert: session name in list; no Agent card grid (`queryByTestId('agent-grid')` null); click session → header title; default `surface-switcher` tab Terminal selected; switch Workspace → Files; Agent tab → `agent-detail`.

Include empty sessions → “No sessions”.

- [ ] **Step 2–4: Implement shell layout:**

```text
div.h-[100dvh].flex
  aside.w-72.border-r  SessionList
  main.flex-1.flex.flex-col
    SessionHeader (or empty header if no selection)
    div.flex-1.min-h-0.relative
      SessionFirstTerminal hidden={surface!=='terminal' || !selected}
      Workspace panel hidden={surface!=='workspace'} (absolute inset-0 or sibling with hidden)
```

Workspace panel: `WorkspaceNavigation` + tool body.

- [ ] **Step 5: Commit** `feat: compose Session-first shell and auto-attach`

---

### Task 11: App swap + Dashboard toggle

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/DashboardHeader.tsx` (add compact control)
- Test: `web/src/__tests__/integration/App.sessionFirst.test.tsx`
- Test: extend `web/src/components/__tests__/integration/DashboardHeader.test.tsx` if it exists; otherwise assert via App mock.

When `sessionFirst` is true, `appRouter` element is `SessionFirstShell` with the **same** children paths as today (`/`, `terminal/:sessionId`). Drop `env` or Navigate `env` → `/` while flag on.

Lift flag into `App` state:

```tsx
const [sessionFirst, setSessionFirstOn] = useState(() => isSessionFirst());
```

Pass `onLegacy={() => { setSessionFirst(false); setSessionFirstOn(false); }}` into the shell.

Dashboard: button “Session-first preview” `data-testid="use-session-first"` → `setSessionFirst(true); setSessionFirstOn(true)`.

- [ ] **Step 1: App test**

```tsx
vi.mock('@/lib/sessionFirst', () => ({
  isSessionFirst: () => mockOn,
  setSessionFirst: vi.fn(),
}));
vi.mock('@/session-first/SessionFirstShell', () => ({
  SessionFirstShell: () => <div data-testid="session-first-shell" />,
}));
vi.mock('@/components/Dashboard', () => ({
  Dashboard: () => <div data-testid="legacy-dashboard" />,
}));
vi.mock('@/hooks/useAppConnection', () => ({
  useAppConnection: () => ({
    connectionStatus: 'authenticated',
    wsService: {},
    authToken: 't',
    setAuthToken: vi.fn(),
    serverUrl: 'ws://x',
    setServerUrl: vi.fn(),
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    isAuthenticated: true,
    isRestoringSession: false,
  }),
}));
```

Two describes or `mockOn` mutable boolean: off → `legacy-dashboard`; on → `session-first-shell`. Need `MemoryRouter`? App uses `RouterProvider` + `createHashRouter`. Render `<App />` after setting `mockOn`.

- [ ] **Step 2: FAIL (App always Dashboard)**

- [ ] **Step 3: Implement swap in `App.tsx` `appRouter` `useMemo` deps including `sessionFirst`.**

- [ ] **Step 4: PASS**

- [ ] **Step 5: `npx tsc --noEmit` and `npm run lint` in `web/`** — fix all issues (no eslint-disable).

- [ ] **Step 6: Commit** `feat: swap Dashboard for Session-first shell behind flag`

---

### Task 12: Playwright verification (PR gate)

No production code unless a bug is found.

- [ ] **Step 1: Start local stack** (isolated HOME):

```bash
HOME=/tmp/nession-demo cargo run -p nession-server
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml
cd web && npm run dev
```

- [ ] **Step 2: Browser** `http://localhost:13000/?session_first=1` — login with any non-empty token (`localStorage` already set by query).

- [ ] **Step 3: Exercise and screenshot** to `.playwright-mcp/screenshots/`:

| File | Scene |
|------|--------|
| `session-first-list.png` | Flat session list (create a tmux session if empty) |
| `session-first-terminal.png` | After select — Terminal default, no Files split |
| `session-first-files.png` | Workspace → Files → open a file |
| `session-first-agent.png` | Workspace → Agent detail with three channels |
| `session-first-terminal-return.png` | Back to Terminal |
| `session-first-empty.png` | Empty list if reproducible |
| `session-first-agent-offline.png` | Offline/stale row copy if reproducible |

- [ ] **Step 4: Confirm console has no slice-caused errors** (`browser_console_messages`).

Playwright is the PR proof; do not skip because unit tests passed.

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Flag query + storage, default off | 1, 11 |
| No crates/protocol | all (forbidden paths) |
| New AgentDetail | 7 |
| Reuse TerminalPane, not TerminalWorkspace | 9 |
| Hide not unmount terminal | 9, 10 |
| Wire mapping + stale + offline listed | 2, 5 |
| Domain CSS tokens, no `bg-green-500` | 3, 4–8 |
| Files attach-first empty | 8 |
| Auto attach without Env dialog | 10 (`resolveDeepLinkAttachChoice`) |
| App swap | 11 |
| Playwright path | 12 |
| `/terminal/:id` still works with flag | 11 same child routes |

## Placeholder scan

No TBD. Attach failure id is `attachFailedId` in mapper and shell. Workspace tool ids are `'files' | 'session' | 'agent'`. Flag key is `nession_session_first`.

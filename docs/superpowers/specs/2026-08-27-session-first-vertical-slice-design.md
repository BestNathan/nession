# Session-first Vertical Slice Design

**Date:** 2026-08-27  
**Status:** Approved  
**Requirements:** GitHub Issue [#471](https://github.com/BestNathan/nession/issues/471)  
**Parent:** [#468](https://github.com/BestNathan/nession/issues/468)  
**Depends on:** architecture [#469](https://github.com/BestNathan/nession/issues/469), pattern specs [#470](https://github.com/BestNathan/nession/issues/470)  
**Does not depend on shipping:** executable tokens [#467](https://github.com/BestNathan/nession/issues/467) (direction only)

---

## Overview

Phase 3 of UI Architecture v2: one Web vertical slice that proves Session-first IA without migrating the whole Dashboard and **without changing the server, agent, or protocol**.

Validation path:

```text
Session List → Select Session → Terminal → Workspace → Files → Editor → Agent Detail → Terminal
```

When a client flag is on, `App` renders a new Session-first shell instead of `Dashboard`. Flag off (default) is the shipping Agent-first UI.

Architecture and pattern contracts live in [`docs/design/`](../../design/README.md). This spec records **implementation decisions** for the slice.

---

## Key Decisions

### 1. Isolation: feature flag replaces Dashboard (option B)

**Decision:** One authenticated shell at a time. `session_first` on → `SessionFirstShell`; off → `Dashboard`. No `/v2` hash route. No production cutover.

**Rationale:** Matches “alongside legacy until Phase 4” without a second IA in the URL. Playwright and dogfooding flip one flag.

### 2. Flag: query wins, then localStorage (same as `server_url`)

**Decision:**

| Source | Behavior |
|--------|----------|
| Query `session_first=1` or `=0` | Wins for that load; written to `localStorage` |
| `localStorage['nession_session_first']` | `'1'` / `'0'` |
| Neither | **Off** (legacy Dashboard) |

Read `window.location.search` (not the hash), matching `useAppConnection` (`token`, `server_url`).

Module: `web/src/lib/sessionFirst.ts` — `isSessionFirst()`, `setSessionFirst(boolean)`. Both shells expose a control to flip and re-render/reload.

**Rationale:** Server stays unaware. Demos force the flag with a URL; refresh keeps the choice.

### 3. Server/protocol frozen (forward compatible)

**Decision:** No changes under `crates/`. Existing `agents.list`, `sessions.list` (including `stale_agents`), attach, P2P, and file APIs only. Old clients and flag-off Web keep working. New shell must run against a **current** server.

**Rationale:** Explicit constraint: 向前兼容. The three domain channels are a **client mapping**, not new wire fields.

### 4. New AgentDetail; leave `AgentDetailPanel` on Dashboard (option B)

**Decision:** Workspace → Agent is a new pattern component per [`docs/design/design-system/patterns/agent-detail.md`](../../design/design-system/patterns/agent-detail.md). Shipping `AgentDetailPanel` is not imported into the slice.

**Rationale:** Avoid dragging Agent-first session lists and primitive health pills into v2 chrome.

### 5. New shell, reuse terminal and files — not `TerminalWorkspace`

**Decision:** Import attach atoms, P2P, `useTerminal` / `TerminalPane`, `FileBrowser`, `FileViewer`, `createFileOps`, and dashboard **data** hooks. Do **not** mount `TerminalWorkspace` or `TerminalLayout` (they keep Files beside Terminal). Do **not** reuse shipping `SessionList.tsx` (fused status + primitive dots).

**Rationale:** Lowest risk to PTY/files; satisfies “one surface at a time.”

### 6. Hide TerminalPane when Workspace is showing (keep-alive)

**Decision:** Workspace does not unmount xterm. CSS / `hidden` so scrollback survives Files → Terminal.

---

## Architecture

```text
App (authenticated)
  ├─ isSessionFirst() === false → Dashboard (unchanged)
  └─ isSessionFirst() === true  → SessionFirstShell
        ├─ SessionList / SessionItem     (new)
        ├─ SessionHeader
        │    AgentContext, ConnectionStatus, SurfaceSwitcher
        ├─ Terminal surface              TerminalPane + existing attach/P2P
        └─ Workspace surface
             WorkspaceNavigation (in-shell registry: Files, Session, Agent)
             FileWorkspace → FileBrowser | FileViewer
             Session details (read-only facts from Session)
             AgentDetail (new)
```

Hash routes `/terminal/:sessionId` and `/env` remain **legacy-only**. While the flag is on, do not mount `Dashboard` or its `resolveRouteView`. Attach happens inside the shell.

### Layout (Web)

```text
┌─ SessionList ─────────┬─ SessionHeader
│  SessionItem          │  SurfaceSwitcher  [ Terminal | Workspace ]
│  …                    ├─────────────────────────────────────────────
│                       │  Terminal  XOR  Workspace (one visible)
└───────────────────────┴─────────────────────────────────────────────
```

Compact switcher; maximum xterm viewport. Files live **inside** Workspace, not as a permanent split.

---

## Domain mapping (client-only)

Wire types stay `Agent.status: online | offline | degraded` and `Session.status: active | detached | zombie`.

### Agent connection

| Wire | Domain | Copy |
|------|--------|------|
| `online` | `agent.online` | Quiet |
| `offline` | `agent.offline` | “Agent offline” / “Agent unreachable” |
| `degraded` | `agent.error` | “Agent error” |
| id in `stale_agents` | unhealthy even if `online` | “Agent did not respond” — never “Session offline” |

`agent.connecting` / `agent.reconnecting` unused until protocol has them. Client↔server `connectionStatus` is **not** this channel.

### Session lifecycle

| Wire `session.status` | Session channel |
|----------------------|-----------------|
| `active` or `detached` | `session.active` (tmux still exists) |
| `zombie` | `session.exited` |
| cannot join to an agent | `session.unknown` |

Wire `detached` means no attached clients **on the agent**, not this-client attachment.

### This-client attachment

| Client fact | Channel |
|-------------|---------|
| `sessionIdAtom === row.session_id` and attach succeeded | `attached` |
| attach in flight for that row | `attaching` |
| not the active client session | `detached` |
| attach failed for that row | `failed` |

### Reachability scenario

Agent `offline` (or stale) **and** session still in `sessions.list` → row **stays**. Agent channel prominent; Session channel not `exited`. Slice list filter defaults to **all sessions** (Dashboard’s “online only” filter is not applied).

### Workload hint

No wire field. Show `shell` or omit. No CLI output parsing.

---

## Tokens

[#467](https://github.com/BestNathan/nession/issues/467) is not a blocker. Slice-only CSS variables on new chrome, mapped to the existing semantic theme:

```text
--agent-online, --agent-offline, --agent-error
--session-active, --session-exited
--attachment-attached, --attachment-failed
```

New TSX: those names or shadcn semantic utilities (`text-muted-foreground`, `text-destructive`, `bg-background`). **Forbidden on new surfaces:** `bg-green-500`, `text-green-400`, hex/rgb/oklch literals. Legacy Dashboard CSS unchanged.

---

## Attach and Files

- Select SessionItem → existing `attachToSessionAtom` with default `auto` (no Env manager in the slice).
- Switching rows: existing detach/attach atoms.
- Terminal is the default surface after select.
- Files require `fileOps` from an attached session. Workspace → Files while detached: empty state “attach first”, not a fake tree.
- Concurrent switch and attach failure: `attachment.failed` distinct from `agent.offline` and `session.exited`.

---

## Workspace registry (slice)

In-shell array, not [#193](https://github.com/BestNathan/nession/issues/193) plugins:

```text
Files | Session | Agent
```

`availability` may hide Files when there is no file API / not attached. No Git / Preview / Processes.

---

## Testing

### Unit

- `sessionFirst.ts`: query wins; writes storage; default off; `=0` forces legacy.
- Mapper: wire + `sessionIdAtom` / attach error / `stale_agents` → three channels, including Agent offline + session still listed.

### Component

- Flag on → Session-first; off → `Dashboard`.
- SurfaceSwitcher: Terminal XOR Workspace.
- Files master/detail inside Files only.
- Agent tool renders new AgentDetail, not `AgentDetailPanel`.

### Playwright (mandatory for PR)

Local stack, `session_first=1`:

1. Session list → select → Terminal default  
2. Workspace → Files → open file in editor  
3. Workspace → Agent detail  
4. Return to Terminal (scrollback still present if output existed)  
5. Empty list  
6. Agent-offline (or stale) row copy  
7. Attach failure ≠ Agent offline  

Screenshots: `.playwright-mcp/screenshots/`.

---

## Non-goals

- App spatial model ([#473](https://github.com/BestNathan/nession/issues/473))
- Migrating Env manager, extensions, quick commands, remaining Dashboard ([#472](https://github.com/BestNathan/nession/issues/472))
- Token JSON, codegen, ESLint primitive ban ([#467](https://github.com/BestNathan/nession/issues/467))
- New Workspace tools
- Protocol / Rust changes
- Parsing AI CLI into a conversation model

---

## File sketch (implementation plan will lock paths)

| Area | Likely path |
|------|-------------|
| Flag | `web/src/lib/sessionFirst.ts` |
| Mapper | `web/src/session-first/domainState.ts` (or `web/src/lib/`) |
| Shell | `web/src/session-first/SessionFirstShell.tsx` |
| Patterns | `web/src/session-first/patterns/*` |
| Slice tokens | `web/src/index.css` (scoped) or `web/src/session-first/tokens.css` |
| Swap | `web/src/App.tsx` |

Exact files and TDD order: implementation plan after this spec is accepted.

---

## Success criteria (from #471)

- [ ] Validation path completable without Agent-first navigation  
- [ ] Terminal default after Session select  
- [ ] Files opens editor; Agent detail reachable; return to Terminal works  
- [ ] Agent offline / stale while Session listed, correct reachability copy  
- [ ] New surfaces use domain/semantic tokens, not raw palettes  
- [ ] Playwright screenshots on the PR  
- [ ] Flag default off; no server changes  

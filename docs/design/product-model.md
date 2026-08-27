# Product Model

Nession is a **remote session workspace**, not an Agent runtime.

Nession clients connect to remote Nession Agents. An Agent is the proxy/control endpoint for tmux: it discovers and manages tmux-backed sessions and provides the path clients use to attach, detach, and interact with them.

A Session may run any terminal workload. Claude Code, Codex, Cursor CLI, shells, TUIs, editors, and similar programs are workloads inside a Session. They are not Nession's core domain model.

```text
Nession Client
      │
      ▼
    Agent
      │
      │ proxy / control
      ▼
    tmux
      │
      ▼
   Session
      │
      ├── Terminal
      └── Workspace
```

## Core concepts

### Agent

- Remote connection endpoint.
- Proxy/control layer for tmux.
- Responsible for session discovery/control and the attach/detach path.
- Important infrastructure context, but **not** the primary navigation object.

### Session

- Primary user-facing work object.
- Persistent remote work session backed by tmux.
- Reached through an Agent.
- The main object users return to and switch between.

### Terminal

- Primary interactive surface for a Session.
- xterm.js on Web and the equivalent terminal surface on App.
- Nession stays workload-agnostic: AI coding CLIs are common workloads, not a required conversation model.

### Workspace

- Session-scoped auxiliary capabilities.
- Used when the terminal alone is insufficient.
- Initial capabilities: Files, Session details, Agent details.
- Future capabilities may include Git, Preview, Processes, and others. See [workspace.md](workspace.md).

## Product principle

> Session is the primary navigation object. Terminal is the primary work surface. Workspace augments the Session. Agent is persistent infrastructure context and the tmux proxy behind the Session.

Short form:

> **Session-first, Agent-aware, Terminal-first.**

## Domain state model

Infrastructure connection, tmux/session lifecycle, and client attachment are **independent dimensions**. Do not collapse them into `session.running` / `session.failed`.

```text
Agent connection state
├── online
├── connecting
├── reconnecting
├── offline
└── error

Session state
├── active
├── exited
└── unknown

Attachment state
├── attached
├── attaching
├── detached
└── failed
```

### Example: Agent offline, Session still exists

An Agent may be offline while its tmux Session still exists remotely. The UI must present this as an **Agent connectivity problem**, not as a claim that the Session itself is necessarily gone or failed.

| Dimension | Value | Meaning |
|-----------|-------|---------|
| Agent connection | `offline` | Client cannot reach the tmux proxy |
| Session | `active` (last known) or `unknown` | Remote tmux session may still be running |
| Attachment | `detached` or `failed` | This client is not attached |

The same independence applies in the other direction: a Session can be `exited` while the Agent remains `online`, and a client can be `detached` from an `active` Session without implying Agent failure.

This vocabulary feeds the Domain token taxonomy in [#467](https://github.com/BestNathan/nession/issues/467). See [design-system/tokens.md](design-system/tokens.md).

## What this model is not

- Nession is not an AI chat client.
- The core client does not own Conversation, User Message, Agent Message, or Tool Call as IA or domain objects.
- Parsing Claude Code / Codex / other CLI output into a Nession-owned conversation model is out of scope for this architecture.
- Making Agent invisible is not the goal. Agent stays visible as infrastructure context, with progressive disclosure ([information-architecture.md](information-architecture.md)).

## Shared semantics, specialized interaction

Web and App share this product model and domain IA. They specialize interaction and presentation:

- Web: [interaction/web.md](interaction/web.md)
- App: [interaction/app.md](interaction/app.md)

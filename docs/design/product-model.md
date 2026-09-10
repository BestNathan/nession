# Product Model

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md)

Nession is an **intelligent workspace** that makes work continuous across devices, environments, and compute nodes.

The current implementation is built around remote tmux-backed Sessions, but tmux, a single Agent, or a single remote directory must not become the permanent product boundary. The product model should preserve a stable user-facing mental model while the underlying execution topology evolves.

## Core model

```text
Logical Workspace
      │
      ├── Workspace Location A ── Agent / provider ── directory / environment
      │          │
      │          └── Session(s)
      │                 │
      │                 ├── Terminal
      │                 └── contextual capabilities
      │
      └── Workspace Location B ── Agent / provider ── directory / environment
                 │
                 └── Session(s)
```

### Workspace

A Workspace is the logical context of a piece of work.

It is broader than a file browser and broader than one Agent directory. A Workspace may initially map to one physical directory, but the model must allow the same logical work to span multiple locations and execution environments over time.

Workspace answers questions such as:

- what resources belong to this work;
- which environments or locations participate in it;
- which capabilities are available or relevant here;
- what state exists beyond the currently active Session.

See [workspace.md](workspace.md).

### Workspace Location

A Workspace Location is a physical realization of part of a Workspace: for example a directory on a local machine, a remote development host, a sandbox, or another execution environment.

A location may be reached through a Nession Agent or another future provider. "Local" and "remote" are properties of locations, not separate product models.

### Session

A Session is the primary active work object users create, return to, and switch between.

Today a Session is normally backed by tmux and executes on one Workspace Location. Conceptually it carries enough context to answer where the work is running and which Workspace it belongs to, without requiring the user to navigate through infrastructure first.

A Session may run any terminal workload: shells, TUIs, Claude Code, Codex, OpenCode, editors, operational tools, and others.

### Terminal

Terminal is the primary live interaction surface for the current Session implementation.

It should dominate the working surface while it is the user's current work, but "Terminal-first" is a downstream product/interaction decision rather than the top-level Vision. Nession can add richer contextual interaction around the terminal without turning the terminal into a container for permanent chrome.

### Agent

An Agent is infrastructure context: a node-side connection, capability, and execution endpoint.

It may manage tmux-backed Sessions, expose filesystem or environment capabilities, and participate in Workspace Locations. Agent identity and health remain observable when useful, but Agent should not become the default navigation parent for the user's work.

### Capability

A Capability is functionality that Nession itself or an extension can contribute to a Session, Workspace, or environment.

Examples include Files, Git, Claude Code integration, commands, preview, processes, environment management, Kubernetes, or database tools.

A useful generic lifecycle is:

```text
unavailable -> available -> relevant -> active
```

This lifecycle is a product-state vocabulary, not a requirement for one specific detection implementation.

- **unavailable** — the environment cannot provide the capability; it should not occupy UI.
- **available** — the capability exists and may be discoverable where useful.
- **relevant** — the current Workspace or Session gives the capability a reason to gain presence.
- **active** — the capability is participating in the current work and may surface directly in the Session interaction layer.

Extensions contribute capability and state; Nession owns how that presence is integrated into the product experience. See [`PRINCIPLE.md`](../../PRINCIPLE.md).

## Product relationship

The current downstream product model can be summarized as:

> **Session is the primary active work object. Terminal is the primary live surface today. Workspace provides contextual depth around the work. Agent and execution topology are infrastructure context. Capabilities emerge according to relevance and activity.**

This summary is intentionally downstream from the root Vision and Principles. If the implementation changes, the Vision should not need to change with it.

## Domain state dimensions

Infrastructure connectivity, Session lifecycle, and client attachment are independent dimensions. Do not collapse them into a single `session.running` / `session.failed` state.

```text
Agent / location connectivity
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

For example, an Agent may be offline while a tmux Session still exists remotely. The product should present an infrastructure reachability problem without falsely claiming that the work itself has disappeared.

The same independence applies in the other direction: a Session can be exited while an Agent remains online, and a client can be detached from an active Session without implying infrastructure failure.

## AI and tool semantics

Nession does not require every workload to adopt an AI-chat domain model.

Conversation, tool-call, plan, or task semantics are therefore **not universal core objects** merely because a coding agent can run in a Session. However, an extension may expose structured state for a specific capability when that state improves the current work experience.

For example, a Claude Code integration may expose its current conversation, status, history, or actions as contextual capability data. That does not make Claude Code the product model, and it does not require ordinary shell Sessions to pretend they are conversations.

This boundary allows Nession to stay workload-agnostic at the core while still becoming substantially more intelligent around workloads it can understand.

## Current implementation versus target model

Today, logical Workspace identity and Workspace Locations may be inferred from Session, Agent, and current-directory information rather than represented as complete first-class persisted entities.

That is an implementation stage, not a reason to redefine Workspace permanently as "the tools beside one Session". Lower-level code and migration documents should move toward this model incrementally.

## Shared semantics, specialized interaction

Web and App share these concepts while specializing presentation and navigation:

- Web: [interaction/web.md](interaction/web.md)
- App: [interaction/app.md](interaction/app.md)

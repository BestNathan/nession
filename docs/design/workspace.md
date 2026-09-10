# Workspace

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product-model.md](product-model.md)

Workspace is the logical context around a piece of work. It is not a synonym for File Browser, not a permanent feature menu, and not limited to one Agent or one Session.

A Workspace may initially be represented by one directory on one Agent, but the product model must allow the same logical work to span multiple physical locations and execution environments.

## Logical Workspace and physical locations

```text
Workspace
├── Location: local Mac / Agent
│   └── /Users/nathan/code/nession
├── Location: remote dev host / Agent
│   └── /workspace/nession
└── Location: cloud / sandbox provider
    └── /workspace
```

A **Workspace Location** describes where part of the work physically exists or executes. Local and remote are properties of a location rather than separate kinds of Workspace.

A Session normally executes in one location and carries its current directory/context. Moving between Sessions or devices should not force the user to rebuild the meaning of the Workspace.

The current implementation may infer this relationship from Agent + Session + cwd until logical Workspace identity becomes explicitly persisted.

## What Workspace should answer

Workspace is the deeper contextual view the user opens when the active Session alone is insufficient.

It should help answer questions such as:

- What resources belong to this work?
- Which locations/environments participate in it?
- What capabilities are available or relevant here?
- What state exists outside the currently visible Terminal?
- What configuration or history is useful for the current work?

It should **not** primarily answer "what features does Nession have?"

## Capabilities, not a feature lobby

Files, Git, Claude Code, environment management, preview, processes, Kubernetes, databases, and future extensions are capabilities that may contribute to a Workspace.

They must not automatically become permanent navigation entries merely because they are registered.

The generic lifecycle is:

```text
unavailable -> available -> relevant -> active
```

Workspace presentation follows that state:

| State | Workspace behavior |
|-------|--------------------|
| `unavailable` | Hidden. Do not reserve empty or disabled chrome merely to advertise the feature. |
| `available` | May be discoverable when useful, without demanding attention. |
| `relevant` | May gain a visible section, shortcut, summary, or contextual action. |
| `active` | May show live state and stronger presence; Session-level presence may also appear. |

This replaces the older assumption that every registered Workspace tool should always occupy a bottom toolbar, including disabled pills.

A capability can be discoverable without being permanently visible.

## Contribution model

Prefer a capability registry over hard-coded feature conditionals, but keep the registry below the product experience.

An extension should contribute semantic information rather than dictate global layout. Conceptually:

```ts
interface WorkspaceCapability {
  id: CapabilityId
  availability(ctx: WorkspaceContext): CapabilityState
  summary?(ctx: WorkspaceContext): CapabilitySummary
  actions?(ctx: WorkspaceContext): CapabilityAction[]
  view?(ctx: WorkspaceContext): CapabilityView
}
```

The exact TypeScript/Rust API is an implementation concern. The product contract is more important:

- extensions provide capability, state, actions, and optional deeper views;
- Nession decides where and how they appear;
- placement depends on context and capability state;
- Web and App may render the same capability differently while preserving meaning;
- adding an extension must not require redesigning the global shell.

## Session-level versus Workspace-level presence

Session and Workspace expose different depths of the same capability.

### Session

The Session layer is about **what is happening now**.

An active capability may gain lightweight presence near the interaction surface. For example, if Claude Code becomes active in the current terminal, Nession may expose its identity, state, and contextual actions without opening a permanent panel.

### Workspace

The Workspace layer is about **what belongs to or is relevant to this work**.

It may expose broader capability state, configuration, resources, history, or location-specific information even when that capability is not the foreground application at this exact moment.

This distinction allows Workspace to be rich without making the Session noisy.

## Example: Claude Code

Claude Code is a reference integration for the generic model, not a special-case Workspace architecture.

```text
Claude Code not installed
    -> no Claude Code surface

Claude Code installed for a Workspace Location
    -> capability may be discoverable in Workspace

Claude Code becomes relevant to the current work
    -> Workspace may surface related state/actions

Claude Code is running in the active Session
    -> lightweight Session presence + contextual actions
    -> deeper capability view only when explicitly opened
```

The same pattern should be reusable for Codex, OpenCode, Git, Docker, Kubernetes, databases, and other capabilities.

## Files is one capability

Files may use a browser/editor master-detail layout internally:

```text
Files
┌──────────────────────┬────────────────────────────────────┐
│ File Browser         │ Editor                             │
│ src/                 │ AgentCard.tsx                      │
│ ├ components/        │ export function ...               │
│ ├ hooks/             │                                    │
│ └ lib/               │                                    │
└──────────────────────┴────────────────────────────────────┘
```

That layout belongs to Files. It is not the global Workspace layout and should not cause Workspace itself to grow a permanent inner sidebar.

## Multi-location behavior

As logical Workspace support grows, capabilities may have location-specific state.

Examples:

- Git may exist in two cloned locations with different branches or working-tree state.
- Claude Code may be installed on one Agent but not another.
- a local location may expose filesystem access while a cloud sandbox exposes additional runtime controls.

The product should preserve a single logical Workspace while making the active or affected location clear only when that distinction matters.

Do not force users to understand the infrastructure graph before they can work.

## Migration note

The current Web implementation contains Workspace tool registries, tool bars, Agent/Session detail tools, and other structures created during the Session-first migration. They remain useful implementation assets, but they are not automatically the long-term information architecture.

When those structures conflict with [`PRINCIPLE.md`](../../PRINCIPLE.md), converge them toward contextual presence rather than preserving them because they already ship.

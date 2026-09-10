# Information Architecture

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product-model.md](product-model.md)

Nession's information architecture starts from the user's current work rather than from tools or infrastructure.

For the current product model, **Session is the primary active work object**, Terminal is the default live surface, Workspace is contextual depth around that work, and Agent/location information is infrastructure context disclosed when useful.

## Top-level mental model

```text
Nession
│
├── Sessions                         PRIMARY WORK NAVIGATION
│
├── Active Session                   CURRENT WORK
│   │
│   ├── Terminal                     DEFAULT LIVE SURFACE
│   │
│   ├── Contextual capability presence
│   │   ├── active capability identity / state
│   │   ├── contextual actions
│   │   └── explicitly opened deeper surfaces
│   │
│   └── Workspace                    CONTEXTUAL DEPTH
│       ├── resources
│       ├── relevant / available capabilities
│       ├── Workspace Locations
│       └── infrastructure context when needed
│
└── Settings                         PRODUCT / ACCOUNT CONFIGURATION
```

This is not a permanent feature tree. Workspace content and Session capability presence are context-driven.

## Session-first navigation

Users should be able to return directly to work without navigating through Agent → directory → tool hierarchies first.

The primary Session list therefore remains flat by default. Agent, location, workload, and recency may appear as compact metadata, but they are not required navigation parents.

```text
Sessions

● Fix terminal reconnect
  Claude Code · devbox-01 · 2m

● Design system
  Codex · macbook · 12m

○ Production shell
  zsh · sg-prod · 1h
```

The navigation familiarity of a conversation list is useful, but Nession should not force every Session into a chat domain model.

## Current work before feature catalog

The Active Session should answer "what am I doing now?" before the UI answers "what features does Nession have?"

This means:

- Terminal or the current work surface receives the majority of space and attention.
- Generic feature navigation should not permanently compete with the work surface.
- Infrastructure context stays quiet when healthy and gains prominence when it affects the work.
- Capabilities gain presence because the current context makes them useful, relevant, or active.

A capability being installed or implemented is not sufficient justification for permanent top-level navigation.

## Contextual capability presence

Capability presence is derived from the product-state vocabulary defined in [product-model.md](product-model.md):

```text
unavailable -> available -> relevant -> active
```

IA consequences:

- **Unavailable:** hidden; no dead navigation slot is required.
- **Available:** may be discoverable in Workspace or an explicit capability picker when useful.
- **Relevant:** can be promoted within Workspace and contextual actions.
- **Active:** can gain lightweight presence directly in the current Session and interaction capsule.

Deeper capability surfaces are explicitly opened. They should not automatically replace the main work surface merely because a capability is active.

Claude Code is the first reference integration for this pattern, not a special IA branch.

## Agent and Workspace Location progressive disclosure

Agent/location information can appear at several depths without becoming the primary navigation model:

1. **Session list** — compact metadata where it helps identify work.
2. **Active Session context** — current location/connectivity when relevant.
3. **Workspace** — fuller location, environment, and capability context.
4. **Dedicated detail/configuration** — explicitly requested infrastructure detail.

When connectivity is healthy, infrastructure state should remain visually quiet. When it threatens reachability or work continuity, it can become prominent.

## Workspace in the IA

Workspace is not synonymous with File Browser and is no longer defined as only "Session-scoped tools".

Workspace is the contextual layer for the logical work represented by [workspace.md](workspace.md). A current Session normally executes in one Workspace Location, while Workspace may expose resources or state across additional locations over time.

Workspace should not be implemented as a feature lobby containing every registered plugin. Its visible structure should follow the current Workspace context and capability state.

## What the IA deliberately does not make universal

The core IA does not require Conversation, User Message, Agent Message, Tool Call, or Plan to exist for every Session.

Specific extensions may expose those concepts as capability-specific state when the active workload supports them. That state remains contextual to the capability rather than redefining every Session.

## Platform realization

Web and App share this IA but realize it differently:

- Web: [interaction/web.md](interaction/web.md)
- App: [interaction/app.md](interaction/app.md)

Gestures, drawers, overlays, and exact control placement are interaction decisions, not product-level IA.

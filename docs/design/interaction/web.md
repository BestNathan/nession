# Web Interaction Model

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [information architecture](../information-architecture.md)

Web shares the same product semantics as App but realizes them for a large pointer-driven surface.

The current work remains dominant. Session navigation, Workspace, infrastructure detail, and extension capabilities should remain reachable without becoming permanent competing chrome.

## Top-level model

```text
Session navigation       Active Session
      │                       │
      │                       ├── Terminal / current work surface
      │                       ├── contextual capability presence
      │                       └── Workspace contextual depth
      │
      └── on demand / compact / collapsible
```

Terminal remains the default live surface for the current Session implementation.

## Session navigation

Sessions are the primary way to return to work, but a persistent full-width navigation column is not an invariant.

On Web, Session navigation may use a drawer, collapsible rail, compact sidebar, command/search entry, or another pattern that preserves fast switching while letting the active work surface dominate.

The product rule is stronger than the exact control:

- users can switch Sessions quickly;
- Agent/location metadata remains secondary;
- navigation does not consume permanent space merely because it can;
- current work receives the majority of the frame.

## Terminal and Workspace

Terminal and Workspace are related but serve different depths:

- **Terminal / current Session surface:** what is happening now.
- **Workspace:** resources, locations, broader state, and capabilities relevant to the work.

Only the layer the user currently needs should receive significant visual weight.

A compact Workspace affordance or surface switcher may exist, but it must not become a permanent feature catalog. Opening Workspace should preserve Session identity and continuity.

Do not treat a persistent Terminal | Files split as the global Web shell. Files is one Workspace capability.

## Contextual interaction capsule

Web should use the same core interaction idea as App: a lightweight capsule over or adjacent to the Terminal surface for conversational / intent input.

Its secondary affordances are contextual rather than exhaustive.

Typical sources of additional actions:

- explicit `+` expansion;
- keyboard / command entry;
- current Session state;
- current Workspace context;
- active or relevant capabilities.

The capsule must not accumulate one permanent button per extension.

## Capability emergence

The generic lifecycle is defined in [product-model.md](../product-model.md):

```text
unavailable -> available -> relevant -> active
```

Web presentation should follow the same semantics:

- unavailable capabilities remain hidden;
- available capabilities may be discoverable in Workspace or explicit expansion;
- relevant capabilities can gain contextual presence;
- active capabilities can gain lightweight Session presence and contextual capsule actions;
- deeper views are opened explicitly.

For example, when Claude Code is detected as active in the current Session, Nession may show a small Claude Code presence near the interaction layer and expose session-scoped actions/history/state without replacing the Terminal by default.

## Workspace capability navigation

Workspace must not require one static tab or toolbar entry for every registered capability.

A Workspace implementation may use search, grouped contextual sections, compact switching, a temporary palette, or another presentation chosen by Nession. The visible set should be derived from Workspace context rather than extension registration alone.

Individual capabilities own their internal content model, not the global shell. Files may use master/detail; Git may show repository state; Claude Code may expose configuration/history; Agent/location detail may use a focused information surface.

See [workspace.md](../workspace.md).

## Infrastructure context

Agent and Workspace Location information should remain accessible, but healthy infrastructure should stay visually quiet.

Connectivity or attachment failures may become prominent because they directly threaten the current work. Infrastructure should not become a navigation parent simply because the current transport requires it.

## What Web must not do

- Permanently surround the active work with a dashboard of feature entry points.
- Group primary Session navigation by Agent by default.
- Show unavailable extensions as dead permanent navigation simply to advertise them.
- Turn the interaction capsule into an exhaustive toolbar.
- Require users to leave the Session just to discover an active contextual capability.
- Let extension-specific UI fragment the global Nession interaction model.
- Treat current shipping chrome as more authoritative than the repository Vision and Principles.

## Transport runtime boundary ([#593](https://github.com/BestNathan/nession/issues/593))

The terminal attach implementation uses a shared **SessionRuntime** per `sessionId`:

```text
React
      ↓ subscribe / mirror
SessionRuntimeRegistry
      ↓
SessionRuntime — AgentSocketClient, attach policy, FileCapability
      ↓
ConnectionManager (terminal I/O only; no Jotai reads)
```

This is an implementation boundary, not information architecture.

- React hooks subscribe to runtime state; UI should not redefine transport lifecycle.
- Server relay and P2P sockets correlate through the shared runtime/router model.
- Connection state should surface only to the degree it affects the current work.

As runtime architecture evolves, preserve product semantics rather than exposing transport structure directly in navigation.

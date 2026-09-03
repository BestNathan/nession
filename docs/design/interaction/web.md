# Web Interaction Model

Web shares the [product model](../product-model.md) and [information architecture](../information-architecture.md) with App. It does **not** permanently show Terminal and Workspace side-by-side.

## Top-level layout

```text
┌──────────────────┬───────────────────────────────────────────────┐
│                  │                                               │
│ Sessions         │ Active Session                                │
│                  │                                               │
│                  │       [ Terminal ] [ Workspace ]              │
│                  │                                               │
│                  │            Active Surface                     │
│                  │                                               │
└──────────────────┴───────────────────────────────────────────────┘
```

## Rules

- Session navigation remains available on the left (Sessions sidebar).
- Terminal is the default active surface.
- Terminal and Workspace are top-level **peer** surfaces within the active Session: they occupy the same surface slot. Terminal remains the default; Workspace is auxiliary, not a permanent split.
- Only one of Terminal / Workspace is shown at a time.
- A compact top-level surface switcher/toggle changes the active surface.
- This preserves maximum horizontal and vertical space for xterm.js during normal work.

Do not treat a persistent Terminal | Files split as the Web shell. Files lives inside Workspace; see [workspace.md](../workspace.md).

## Surface vs tool navigation

Two levels, not one merged tab strip:

```text
Surface level:

Terminal | Workspace

Workspace tool level:

Files | Session | Agent | ...
```

Workspace owns its own secondary navigation. Do **not** create another permanent full-width sidebar inside Workspace by default. Prefer compact top navigation / tool switching. Individual tools define their own internal layout (Files may use master/detail; Agent need not).

## What Web must not do

- Permanently display Terminal and Workspace at the same time as the default layout.
- Group the primary Session list by Agent (see [information-architecture.md](../information-architecture.md)).
- Implement Web as a large-canvas copy of the App spatial pager.
- Encode Workspace tool hierarchy as visual tokens ([design-system/tokens.md](../design-system/tokens.md)); that belongs here and in pattern specs ([#470](https://github.com/BestNathan/nession/issues/470)).

## Patterns involved

Web composition is expected to use SessionList, SessionHeader / AgentContext, SurfaceSwitcher, and WorkspaceNavigation. Specs: [design-system/patterns.md](../design-system/patterns.md).

## Transport runtime boundary ([#593](https://github.com/BestNathan/nession/issues/593))

Web terminal attach uses a shared **SessionRuntime** per `sessionId`:

```text
React (session-first + legacy Dashboard)
      ↓ subscribe / mirror
SessionRuntimeRegistry
      ↓
SessionRuntime — AgentSocketClient, attach policy, FileCapability
      ↓
ConnectionManager (terminal I/O only; no Jotai reads)
```

- **Session-first** and **legacy `TerminalWorkspace`** both acquire the same registry entry (`transportFirst: true|false`).
- React hooks (`useSessionRuntime`, `useP2PAttachTransport`) mirror transport state into Jotai; terminal code must not import hook types or call `getDefaultStore()` directly.
- `ConnectionManager` gates outbound input/resize via an explicit `isAttached()` callback wired from the attach state machine.

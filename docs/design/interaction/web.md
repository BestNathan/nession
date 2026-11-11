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

On Web, Session navigation may use a drawer, collapsible sidebar, compact switcher,
command/search entry, or another pattern that preserves fast switching while letting
the active work surface dominate.

The product rule is stronger than the exact control:

- users can switch Sessions quickly;
- Agent/location metadata remains secondary;
- navigation does not consume permanent space merely because it can;
- current work receives the majority of the frame.

The current Web column is **Session-first** (#2851):

- **Top:** one stable sidebar toggle and one explicit New Session action, then one search
  field. This row is the sidebar's own top action group, not a permanent work-surface
  header.
- **Middle:** flat Session history, optionally separated by when the work last happened
  (Today / Previous 7 days / Older). Sessions are never filed under an Agent. One anchored
  `···` menu owns Session details, Edit details, Attach settings and the separated Kill
  action on wide and narrow Web; it overlays the list and never changes selection by itself.
- **Bottom:** one compact Agents / locations entry that reveals Agent detail on request,
  followed by Server connection status alone. An offline Agent does not recolor the
  Server mark, and the footer does not aggregate Session or attachment state.
- Filter, sort and refresh live behind one disclosure in the search field. A chosen
  status filter remains visible as a removable chip. Creation is not repeated as a list
  toolbar row.

When the Web sidebar is collapsed it reserves a **navigation rail**, not a floating
control over the work surface (#3075, superseding #2851's 0px tuck-away and the
historical #1196 static Agent/count rail):

- **56px, in flow.** The rail is a `shrink-0` sibling of Main and stays inside the
  shell's flex column. Main begins at the rail's right edge at every desktop
  width; no absolute or fixed control overlays the Terminal or Workspace. The
  reserved width comes from the shell's canonical `--nession-shell-rail-width`.
- **Purposeful shortcuts only.** One Expand, New Session, Search Sessions, and a
  Projects shortcut only when Projects are navigable. New Session opens the
  existing create flow without submitting; Search expands the column and focuses
  the existing Session field; Projects opens the standalone Project destination
  and preserves the selected Session and Terminal. Server connection status is a
  passive signal, never an Agent/Session/attachment roll-up. A destination that
  does not exist is not shown as a dead icon.
- **Collapse state is owned by the shell composition, once** (#1195/#1196 §5). The
  same state drives the reserved width, the rail, and the expanded column. The
  work surface reclaims the released width through the normal resize pipeline —
  no detach/reconnect.
- **The expanded column stays mounted while collapsed**, so selection, search and
  the Session list's scroll position survive. Its controls are `inert` and
  invisible while the rail is interactive; expanding restores focus deliberately
  (to the chosen action or the column toggle).
- **Every rail icon has an accessible name, keyboard focus and a tooltip.** The
  narrow drawer keeps its own floating opening control; the wide overlay control
  is retired.
- **Server status stays a separate signal** — never a roll-up of Agent, Session, or
  attachment health (`session-list.md` names that collapse an anti-pattern).

### Narrow Web and explicit experience mode

The default narrow viewport is the App spatial experience. The Web composition may also
be selected explicitly with `experience=web` in the URL; its narrow form is the existing
overlay SessionDrawer, not a squeezed column. The drawer closes on selection, its Close
action, Escape or the scrim, and leaves a visible floating control to reopen it. The App
keeps its own `Sessions ← Terminal → Workspace` model and never inherits this collapse
state. `experience=app` is the symmetric explicit override for a wide viewport.

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
- active capabilities can gain lightweight Session presence without modifying the resting capsule;
- `+` is the explicit Nession capability entry, while a capability the user chooses may materialize as a temporary Peek surface;
- deeper views are opened explicitly in Workspace with context preserved.

The shared disclosure model is defined in [capability-emergence.md](../capability-emergence.md):

```text
Dormant -> Peek -> Workspace
```

For example, choosing Git opens a Peek that shows branch/worktree/change state and a short changed-file list. Full diff, history, staging, branches, and worktree management belong in Workspace.

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
SessionRuntime — AddressAttachPolicy, SessionAttachController, AttachStateMachine
      ↓
ConnectionManager (terminal I/O only; no Jotai reads)
```

This is an implementation boundary, not information architecture.

- React hooks subscribe to runtime state; UI should not redefine transport lifecycle.
- Server relay and P2P sockets correlate through the shared runtime/router model.
- Connection state should surface only to the degree it affects the current work.

As runtime architecture evolves, preserve product semantics rather than exposing transport structure directly in navigation.
# App Interaction Model

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [information architecture](../information-architecture.md)

App shares the same product semantics as Web but uses a mobile-native spatial interaction model. It is not a responsive shrink of the Web layout.

## Spatial model

```text
Navigation             Current Work             Contextual Depth

 Sessions     ←──────    Terminal    ──────→      Workspace
```

Default focus is the active Session's Terminal.

Conceptually:

```text
Navigation  ←  Work  →  Context
```

This is a navigation relationship, not a claim that Workspace is a static feature page,
and it is a statement about the **product** rather than about how the App is built. The
App is not required to render a pager, a carousel, or three permanently translated pages.
What the model constrains is where the user can go and what is adjacent to what — not the
mechanism that gets them there.

## Terminal-first Session surface

When the user creates or attaches to a Session, the Terminal should occupy the working canvas.

The surrounding UI stays quiet. Session identity, connectivity, and controls are visible only to the degree needed to understand or recover the work.

The App should feel like returning to an active place of work, not entering a management dashboard.

**The Terminal is the root of a selected Session.** Sessions and Workspace are reached
*from* it and return to it, and while either is open the Terminal stays mounted
underneath. This constrains the implementation, not only the look: a navigation event must
not unmount the Terminal, because unmounting rebuilds xterm, the attach state and the
scrollback, and turns "return to where I was" into a state-restoration problem. Layers,
drawers and pushed views satisfy this by construction. A translated pager satisfies it
only by keeping every page mounted at all times — which worked, but also meant the App
rendered two page headers and two sets of navigation controls at all times, and gave the
shell no way to say which page was current.

## Contextual interaction capsule

A lightweight floating capsule is the primary high-level interaction surface over the Terminal.

Its first responsibility is conversational / intent input. Secondary capability actions should appear only when the user requests them or when the current context gives them a clear reason to exist.

Typical entry mechanisms include:

- the primary input itself;
- a `+` affordance for explicit expansion;
- shortcuts / commands;
- lightweight presence from an active contextual capability, reached through that expansion.

The capsule must not become a permanent toolbar that accumulates every registered feature.

### Capability presence

The resting capsule does not change when a capability becomes available, relevant, or active.

The App uses the disclosure model from [capability-emergence.md](../capability-emergence.md):

```text
Dormant -> Signal -> Peek -> Workspace
```

`+` remains the explicit Nession capability entry. After the user selects a capability, or after context gives it a strong reason to emerge, the App may show a temporary Signal/Peek above the capsule.

For example:

```text
Terminal running a shell
    -> neutral capsule

Git becomes relevant
    -> resting capsule remains unchanged
    -> Git may be discovered/selected through `+`
    -> compact Git Signal: branch / worktree / changes
    -> tap for Git Peek
    -> Open Workspace for full Git
```

Signal/Peek is session-scoped and intentionally shallow. Rich state, history, management, and capability-specific workflows belong in Workspace.

Opening Workspace must preserve the originating Session and capability context. Closing/dismissing returns the user to the same Terminal without rebuilding context.

## Gestures and visible alternatives

- Swipe right to reveal/open Sessions; swipe left to reveal/open Workspace.
- The gesture spans the shell chrome, and is **bounded by work-surface
  exclusion**: it does not begin inside a surface that owns its own touch
  behaviour — the terminal viewport (selection, scrollback, TUI mouse
  reporting), a CodeMirror editor, a text input, or the capsule composer. The
  surface still needs the shell to define *where* top-level navigation may
  start, not only which axis a captured drag resolved to.
- Gestures are accelerators, not the only discoverable or accessible path.
- Sessions and Workspace must also have visible controls, but those controls should remain visually quiet when they are not the user's current intent.

The exact header/button implementation may evolve. The invariant is the spatial relationship and the existence of a visible alternative to gestures.

## Workspace inside App

Workspace is contextual depth around the logical work, not a tool lobby.

Its visible content should be driven by resources, locations, and capability state. Unavailable capabilities do not need disabled permanent slots simply because an extension exists.

Workspace capabilities may use native push/pop navigation internally for deeper details. Nested navigation must not conflict with the top-level `Sessions ← Terminal → Workspace` gestures.

Files may push an editor; Claude Code may open configuration/history; Git may expose repository state. These are capability-internal flows, not a requirement for one shared master/detail shell.

See [workspace.md](../workspace.md).

## Current capability-state mapping

The generic capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

App presentation should normally map it as follows:

- `unavailable`: no presence;
- `available`: optionally discoverable in Workspace / explicit expansion;
- `relevant`: contextual Workspace or capsule affordance may appear;
- `active`: may be marked/discoverable in `+`, and may project a temporary Signal/Peek without changing the resting capsule.

Exact detection is implementation-specific.

## What App must not do

- Ship as a responsive/shrunken Web dashboard.
- Make gestures the only way to reach Sessions or Workspace.
- Turn Workspace into a permanently visible catalog of installed extensions.
- Turn the terminal capsule into a feature toolbar.
- Force every capability to expose its full UI at first contact.
- Let an extension invent its own global navigation or visual language.
- Collapse Agent/location connectivity, Session lifecycle, and attachment into one status.

## Implementation boundary

The implementation does not need to literally maintain three permanently translated pages. Sessions may be a drawer/layer, Terminal the root content, Workspace a contextual layer, and capability details overlays or pushed views.

The App ships this way (#1049): the Terminal is the root and Sessions and Workspace are
layers over it, so opening either one does not unmount the work surface.

The product requirements are:

1. current work remains dominant;
2. the spatial model remains coherent;
3. capability presence follows context;
4. deeper complexity is explicitly opened;
5. visible non-gesture controls remain available;
6. the implementation stays subordinate to [`VISION.md`](../../../VISION.md) and [`PRINCIPLE.md`](../../../PRINCIPLE.md).
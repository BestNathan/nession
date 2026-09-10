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

This is a navigation relationship, not a claim that Workspace is a static feature page.

## Terminal-first Session surface

When the user creates or attaches to a Session, the Terminal should occupy the working canvas.

The surrounding UI stays quiet. Session identity, connectivity, and controls are visible only to the degree needed to understand or recover the work.

The App should feel like returning to an active place of work, not entering a management dashboard.

## Contextual interaction capsule

A lightweight floating capsule is the primary high-level interaction surface over the Terminal.

Its first responsibility is conversational / intent input. Secondary capability actions should appear only when the user requests them or when the current context gives them a clear reason to exist.

Typical entry mechanisms include:

- the primary input itself;
- a `+` affordance for explicit expansion;
- shortcuts / commands;
- lightweight presence from an active contextual capability.

The capsule must not become a permanent toolbar that accumulates every registered feature.

### Capability presence

When a capability becomes active in the current Session, it may earn lightweight presence around the capsule rather than forcing navigation.

For example:

```text
Terminal running a shell
    -> neutral capsule

Claude Code becomes active
    -> Claude Code presence may appear
    -> contextual actions may become available from `+`
    -> user may explicitly open a deeper Claude Code Session surface
```

The deeper surface is session-scoped and should open as a contextual overlay/layer where practical. Closing it returns the user to the same Terminal without changing the active Session.

## Gestures and visible alternatives

- Swipe right from the Terminal surface to reveal/open Sessions.
- Swipe left from the Terminal surface to reveal/open Workspace.
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
- `active`: lightweight Session presence plus optional deeper view.

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

The product requirements are:

1. current work remains dominant;
2. the spatial model remains coherent;
3. capability presence follows context;
4. deeper complexity is explicitly opened;
5. visible non-gesture controls remain available;
6. the implementation stays subordinate to [`VISION.md`](../../../VISION.md) and [`PRINCIPLE.md`](../../../PRINCIPLE.md).

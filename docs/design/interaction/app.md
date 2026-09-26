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

### One navigation bar per depth

Workspace is a stack of depths, and **at any moment exactly one navigation bar owns the
depth on screen**:

```text
Terminal
  ↓
Workspace capability root
  ↓
capability internal push
  ↓
deeper detail
```

Each transition has one predictable back path: from a capability root, Back goes to the
Terminal; from a pushed detail, Back goes to the capability root it was pushed from.

What this rules out is the composition the App shipped with — a page header, a
capability's own push sub-header and the file viewer's close bar rendered as three
independent rows, each answering "what page am I on?" and "what does Back mean?" for
itself. It is the *level*, not the component, that owns navigation.

- **The App shell owns the bar; a capability owns its content and its local actions.**
  A capability declares that it has pushed a depth and what leaving it means; it does
  not render a competing bar. File actions such as Edit and Save belong to the editor
  whose state they act on and may sit in a subordinate toolbar.
- **One leave per depth.** Two controls with the same meaning — a Back and a ✕ both
  ending the same view — are the defect, not a convenience.
- **A guard travels with the state it protects.** Leaving a modified editor must still
  ask before discarding; the capability supplies that guard, so the shell does not have
  to know an editor exists to honour it.
- **Session identity belongs to the Terminal.** It is the depth the Workspace was
  opened from, and it is what the user returns to — not chrome to restate on every
  Workspace screen.

See `#1051` and [workspace.md](../workspace.md). The App presentation of this rule —
including where the capability switcher may appear — is in
[workspace-navigation.md](../design-system/patterns/workspace-navigation.md).

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

## Device and viewport coverage

The executable matrix is [`design/contracts/viewports.json`](../../../design/contracts/viewports.json) — the single source that the browser contract suite iterates. For App it currently pins portrait at 375 / 390 / 430 and landscape at 844×390.

**Two scenarios are not covered, and are recorded here as limitations rather than left silently unchecked** (#1049):

- **Safe area.** Every consumer of `env(safe-area-inset-*)` in the web client uses `-top` or `-bottom`; `-left` and `-right` appear nowhere. That is adequate in portrait, where the notches and the home indicator are top and bottom — but landscape is exactly the case where those insets move to the **sides**, and nothing accounts for that. No fixture sets a non-zero inset, and Playwright cannot synthesise `env()` values without a real device.
- **Software keyboard.** Opening an IME changes the visual viewport, and the capsule is meant to stay docked above it. No test exercises this: jsdom has no keyboard, and the Playwright fixtures run without one. Resizing the viewport in a test is *not* a substitute — it emulates a smaller viewport, not an IME appearing over one.

Closing either needs a real device or emulator. Until then this is a **known evidence gap, not a known defect**: nothing here says the App breaks under an IME or a landscape inset, only that no test would notice if it did.

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
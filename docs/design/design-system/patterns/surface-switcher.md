# SurfaceSwitcher

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [interaction/web.md](../../interaction/web.md)

SurfaceSwitcher is one possible **Web affordance** for moving between the active Session's Terminal and Workspace contextual depth.

It is a compact interaction pattern and not a feature-navigation model.

**Decision (2026-09-28, #1204) — supersedes the #748 form below.** On Web the
affordance is a pair of **reciprocal circular destination actions beside the
local bottom controls**, not a standalone two-state capsule floating at the
work surface's top-right:

- Terminal renders one **"Open Workspace"** circle immediately **right of the
  TerminalCapsule**;
- Workspace renders one **"Open Terminal"** circle immediately **left of the
  capability dock** — and keeps it when a pushed detail depth hides the dock,
  because surface navigation and capability navigation are different axes.

A persistent independent floating switcher can cover live Terminal or Workspace
content, which is especially incorrect for Terminal/TUI surfaces where every
cell may be meaningful. Adjacency to the surface's own bottom control removes
the overlay instead of moving it. The core rule:

> The current surface does not need a permanent control telling the user where
> they already are. The affordance only says where the adjacent action takes
> them.

What survives every revision: **Workspace always has a visible non-gesture
route, and returning to Terminal is equally explicit.**

**Decision (2026-09-16, #748) — superseded, recorded for provenance.** The
switcher was a floating capsule at the workspace's top-right (active Surface
icon+label, inactive icon-only), replacing the SessionHeader segmented control
when the permanent Web header was removed. Its presentation is superseded by
#1204; the invariant it protected — a visible non-gesture route — is not.

**Decision (2026-09-14, #727) — superseded, recorded for provenance:** the
switcher shipped permanently in the SessionHeader, as the only visible
non-gesture route to Workspace, because the alternatives that existed then (the
capsule's capability entry, a deep link) did not replace it. Its rule that
survives both revisions is not "hide it when possible" but **"never render it
without something to switch to"** (see States).

## Purpose

Allow an explicit switch between the current Terminal surface and Workspace when a direct visible control is useful.

Terminal is the default current-work surface. Opening Workspace preserves Session identity and should not imply that Terminal and Workspace deserve equal permanent visual weight.

Must not:

- show Terminal and Workspace side-by-side as the default layout;
- merge Workspace capabilities into the same navigation;
- grow into `Terminal | Files | Env | Git | Claude | ...`;
- remain visible without a Session to switch between (see States: absence, not dead chrome);
- grow into the only way to reach Workspace **without** a shipped replacement — see the decision above;
- pin a surface action independently to viewport or work-surface corners — it belongs to its local control group.

## Anatomy

Each surface renders **one** circular action naming the *destination*, placed
by the local control composition rather than by the work surface:

Terminal active:

```text
            ┌────────────────────┐
            │  TerminalCapsule   │ ( ○ Workspace )
            └────────────────────┘
```

Workspace active:

```text
   ( ○ Terminal ) ┌──────────────────────────┐
                  │ Files  Git  Claude   +   │
                  └──────────────────────────┘
```

The action is a plain button — not a `Tabs` pattern. There is exactly one
action and it navigates on activation; no selected state exists for tab
semantics to model, and the old "click the active segment = no-op" interaction
is gone with the segment.

Geometry rules (#1204 §1, §3):

- **Terminal:** the circle joins the capsule's dock region, bottom-aligned with
  the shell. Its vertical extent is covered by the same terminal clearance the
  capsule already publishes (`useCapsuleDockClearance` →
  `--terminal-capsule-occlusion`); an action no taller than the capsule shell
  adds no terminal row loss, and no second hook may shrink the terminal for it.
- **Workspace:** the circle shares the dock's bottom-center floating group as a
  separate `nav` (surface navigation) adjacent to — never merged into — the
  capability `nav`, and centered against it. The dock's height follows its
  labeled slots (icon over name, #1347), so the circle centers rather than
  matches extent — a taller labeled dock must not stretch the action, and a
  shorter one must not shrink it. When a pushed detail depth hides the
  capability dock, the circle stays at the same bottom position; it never moves
  to a top-right overlay, and a full-surface modal/sheet may still capture it.
- **Pointer ownership:** no transparent full-surface wrapper. Only the button's
  own hit target consumes pointer events; everything outside the real bottom
  controls stays interactive.

## States

| State | Meaning |
|-------|---------|
| `terminal` | Current Session work surface is visible; the "Open Workspace" action sits beside the capsule. Default after selecting/attaching to a Session. |
| `workspace` | Workspace contextual layer/surface is visible; the "Open Terminal" action sits beside the capability dock. |
| No Session | Both actions are absent; do not render dead chrome. |

The affordance does not encode Agent connectivity, Session lifecycle, attachment state, or capability state.

## Relationship to contextual capabilities

Capabilities do not become surface-navigation entries, and surface actions do
not become capabilities.

A capability may be discovered through the Session capsule's `+` expansion and may expose a temporary Peek near the Terminal before deepening into Workspace. The surface affordance remains about **work versus contextual depth**, not about choosing tools. See [../../capability-emergence.md](../../capability-emergence.md).

See [workspace-navigation.md](workspace-navigation.md) and [terminal-capsule.md](terminal-capsule.md).

## Web vs App

| | Web | App |
|--|-----|-----|
| Pattern | Circular destination action beside the local bottom control (#1204) | Not used as the shell |
| Terminal default | Yes | Yes |
| Workspace access | "Open Workspace" beside the TerminalCapsule | Visible Workspace control + swipe-left |
| Terminal access (from Workspace) | "Open Terminal" beside the capability dock | Page-header Back + swipe-right |
| Session access | Separate Session navigation | Visible Sessions control + swipe-right |

App uses the spatial `Sessions ← Terminal → Workspace` model rather than a shrunken segmented control, and does not adopt the Web circles merely because they are compact.

## Visual contract

- Secondary control; never louder than the local primary control (Capsule/Dock).
- **Floating, so it carries the shared floating-surface treatment** (one 1px shadow ring plus two shadow
  layers, no decorative border). `visual-language.md` P7 licenses elevation for a control whose spatial role requires it. See
  [terminal-capsule.md](terminal-capsule.md) § Surface treatment.
- One compact circular button: canonical control target, canonical icon size, capsule-compatible radius producing a circle.
- The button represents the destination: muted icon at rest, foreground on hover/focus, accessible name "Open Workspace" / "Open Terminal".
- No selected fill, no active dot, no resting text label, no badge, no per-surface decorative color, no animation louder than the Capsule/Dock.
- Without a Session there is nothing to switch between, so the control is absent rather than inert.

## Anti-patterns

- `Terminal | Workspace | Files | Agent | Claude` in one control.
- Side-by-side Terminal and Workspace as the default state.
- A large segmented control that steals work-surface space.
- A persistent independent overlay floating over live Terminal/Workspace content.
- A destination action pinned to viewport corners instead of its local control group.
- Treating this widget as required architecture rather than one interaction implementation.
- Reusing it as the App spatial shell.

## Replacing it

This section recorded the order for replacing the header control, and that order
has now been followed twice (#748, and again for the floating capsule in #1204).
It is kept as the rule for any future move:

> Ship the affordance, make Workspace reachable through it, **then** remove the old
> control — updating executable contracts and canonical screenshots in the same
> change. Dropping the old control first is what leaves Workspace unreachable.

Any future revision of the destination-action form follows the same order. The affordance may
change; "Workspace always has a visible non-gesture route" does not.

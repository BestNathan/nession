# SurfaceSwitcher

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [interaction/web.md](../../interaction/web.md)

SurfaceSwitcher is one possible **Web affordance** for moving between the active Session's Terminal and Workspace contextual depth.

It is a compact interaction pattern and not a feature-navigation model.

**Decision (2026-09-16, #748) — supersedes the #727 decision below.** On Web the
switcher is a **floating icon capsule at the workspace's top-right**, not a
segmented control inside the SessionHeader. Web ships no permanent Session
header at all: the shell is a sidebar plus the work surface, and navigation,
infrastructure identity and service status live in the sidebar.

The #727 constraint that governed the old form was an *ordering* rule — ship the
replacement, make Workspace reachable through it, then remove the header control —
and that order was followed: the floating capsule ships in the same change that
removes the header control, and `composition.md` §12, `session-header.md`, the
executable contracts and the canonical screenshots all move with it. What #727
protected is intact: Workspace still has a visible non-gesture route.

**Decision (2026-09-14, #727) — superseded, recorded for provenance:** the
switcher shipped permanently in the SessionHeader, as the only visible
non-gesture route to Workspace, because the alternatives that existed then (the
capsule's capability entry, a deep link) did not replace it. Its rule that
survives this revision is not "hide it when possible" but **"never render it
without something to switch to"** (see States).

## Purpose

Allow an explicit switch between the current Terminal surface and Workspace when a direct visible control is useful.

Terminal is the default current-work surface. Opening Workspace preserves Session identity and should not imply that Terminal and Workspace deserve equal permanent visual weight.

Must not:

- show Terminal and Workspace side-by-side as the default layout;
- merge Workspace capabilities into the same segmented control;
- grow into `Terminal | Files | Env | Git | Claude | ...`;
- remain visible without a Session to switch between (see States: absence, not dead chrome);
- grow into the only way to reach Workspace **without** a shipped replacement — see the decision above.

## Anatomy

The shipped Web form is a floating icon capsule:

```text
                                    ┌───────────┐
                                    │ [▤] [⊞]   │   ← floating, top-right of the work surface
                                    └───────────┘
```

Two icon segments, one per surface. It floats over the work surface rather than
occupying a chrome band, so it costs the work surface no layout space and the
work surface keeps the full frame. Labels are carried by the icons' accessible
names and tooltips, not by permanent text.

The earlier `[ Terminal | Workspace ]` segmented control lived inside the header
because the header existed; with the header gone, a text control floating over
the terminal would be the loudest thing on a quiet surface.

## States

| State | Meaning |
|-------|---------|
| `terminal` | Current Session work surface is visible. Default after selecting/attaching to a Session. |
| `workspace` | Workspace contextual layer/surface is visible. |
| No Session | Control is absent; do not render dead chrome. |

The switcher does not encode Agent connectivity, Session lifecycle, attachment state, or capability state.

## Relationship to contextual capabilities

Capabilities do not become switcher segments.

An active capability may be marked in the Session capsule's `+` expansion and may expose deeper state in Workspace, but the surface affordance remains about **work versus contextual depth**, not about choosing tools.

See [workspace-navigation.md](workspace-navigation.md) and [terminal-capsule.md](terminal-capsule.md).

## Web vs App

| | Web | App |
|--|-----|-----|
| Pattern | Floating icon capsule, top-right of the work surface | Not used as the shell |
| Terminal default | Yes | Yes |
| Workspace access | SurfaceSwitcher or another explicit Web affordance | Visible Workspace control + swipe-left |
| Session access | Separate Session navigation | Visible Sessions control + swipe-right |

App uses the spatial `Sessions ← Terminal → Workspace` model rather than a shrunken segmented control.

## Visual contract

- Secondary control; never louder than the work surface.
- **Floating, so it carries the shared floating-surface treatment** (one 1px shadow ring plus two shadow
  layers, no decorative border) rather than the "no elevation" rule that governed it while it was inline
  header chrome. `visual-language.md` P7 licenses elevation for a control whose spatial role requires it,
  and this one floats over the work surface by design. See
  [terminal-capsule.md](terminal-capsule.md) § Surface treatment.
- One selected state, one quiet unselected state.
- No per-surface decorative color.
- Without a Session there is nothing to switch between, so the control is absent rather than inert.

## Anti-patterns

- `Terminal | Workspace | Files | Agent | Claude` in one control.
- Side-by-side Terminal and Workspace as the default state.
- A large segmented control that steals work-surface space.
- Treating this widget as required architecture rather than one interaction implementation.
- Reusing it as the App spatial shell.

## Replacing it

This section recorded the order for replacing the header control, and that order
has now been followed (#748). It is kept as the rule for any future move:

> Ship the affordance, make Workspace reachable through it, **then** remove the old
> control — updating executable contracts and canonical screenshots in the same
> change. Dropping the old control first is what leaves Workspace unreachable.

Any future revision of the capsule form follows the same order. The affordance may
change; "Workspace always has a visible non-gesture route" does not.

# SurfaceSwitcher

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [interaction/web.md](../../interaction/web.md)

SurfaceSwitcher is one possible **Web affordance** for moving between the active Session's Terminal and Workspace contextual depth.

It is a compact interaction pattern and not a feature-navigation model.

**Decision (2026-09-14, #727):** on Web the switcher **does** ship permanently in
the SessionHeader, and that is now the approved behavior rather than migration
debt. It is the only visible non-gesture route to Workspace — the alternatives
that exist today (the capsule's capability entry, a deep link) do not replace it,
and removing it would strand Workspace behind a control the user has to find
first. The rule that survives is not "hide it when possible" but "never render it
without something to switch to" (see States). Replacing it with a quieter
affordance is a design slice that must ship the alternative *before* the header
loses the control, not a convergence chore to be done later.

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

The simplest current form is:

```text
[ Terminal | Workspace ]
```

This exact segmented control is the shipped Web form. A quieter Workspace affordance — command, drawer/layer entry, contextual transition — remains a legitimate future design, but it has to arrive as a replacement: while the header control is the only visible path, it stays.

## States

| State | Meaning |
|-------|---------|
| `terminal` | Current Session work surface is visible. Default after selecting/attaching to a Session. |
| `workspace` | Workspace contextual layer/surface is visible. |
| No Session | Control is absent; do not render dead chrome. |

The switcher does not encode Agent connectivity, Session lifecycle, attachment state, or capability state.

## Relationship to contextual capabilities

Capabilities do not become switcher segments.

An active capability may gain presence in the Session capsule and may expose deeper state in Workspace, but the surface affordance remains about **work versus contextual depth**, not about choosing tools.

See [workspace-navigation.md](workspace-navigation.md) and [terminal-capsule.md](terminal-capsule.md).

## Web vs App

| | Web | App |
|--|-----|-----|
| Pattern | Shipped permanently in the SessionHeader (decision above) | Not used as the shell |
| Terminal default | Yes | Yes |
| Workspace access | SurfaceSwitcher or another explicit Web affordance | Visible Workspace control + swipe-left |
| Session access | Separate Session navigation | Visible Sessions control + swipe-right |

App uses the spatial `Sessions ← Terminal → Workspace` model rather than a shrunken segmented control.

## Visual contract

- Secondary chrome only; never louder than the work surface.
- Compact and flat; no elevation in healthy chrome.
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

If a quieter affordance is ever designed, the order is: ship the affordance, make
Workspace reachable through it, then remove the header control — updating
executable contracts and canonical screenshots in the same change. Dropping the
control first is what leaves Workspace unreachable, which is why the permanence
above was recorded as a decision instead of being left as debt.

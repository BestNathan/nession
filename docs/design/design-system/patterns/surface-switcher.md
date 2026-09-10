# SurfaceSwitcher

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [interaction/web.md](../../interaction/web.md)

SurfaceSwitcher is one possible **Web affordance** for moving between the active Session's Terminal and Workspace contextual depth.

It is a compact interaction pattern, not a product-level requirement and not a feature-navigation model.

## Purpose

Allow an explicit switch between the current Terminal surface and Workspace when a direct visible control is useful.

Terminal is the default current-work surface. Opening Workspace preserves Session identity and should not imply that Terminal and Workspace deserve equal permanent visual weight.

Must not:

- show Terminal and Workspace side-by-side as the default layout;
- merge Workspace capabilities into the same segmented control;
- grow into `Terminal | Files | Env | Git | Claude | ...`;
- remain permanently visible merely because an implementation already has it if a quieter contextual affordance satisfies the same need.

## Anatomy

The simplest current form is:

```text
[ Terminal | Workspace ]
```

However, this exact segmented control is **not** the canonical product model. Web may later use a quieter Workspace affordance, command, drawer/layer entry, or contextual transition as long as Workspace remains explicit and discoverable.

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
| Pattern | Available when a compact visible Workspace switch is useful | Not used as the shell |
| Terminal default | Yes | Yes |
| Workspace access | SurfaceSwitcher or another explicit Web affordance | Visible Workspace control + swipe-left |
| Session access | Separate Session navigation | Visible Sessions control + swipe-right |

App uses the spatial `Sessions ← Terminal → Workspace` model rather than a shrunken segmented control.

## Visual contract

- Secondary chrome only; never louder than the work surface.
- Compact and flat; no elevation in healthy chrome.
- One selected state, one quiet unselected state.
- No per-surface decorative color.
- If the control is not needed in the current composition, absence is preferable to occupying permanent chrome without purpose.

## Anti-patterns

- `Terminal | Workspace | Files | Agent | Claude` in one control.
- Side-by-side Terminal and Workspace as the default state.
- A large segmented control that steals work-surface space.
- Treating this widget as required architecture rather than one interaction implementation.
- Reusing it as the App spatial shell.

## Migration note

The current Web shell and visual contracts may assume a persistent SurfaceSwitcher. Treat that as an implementation/migration state.

When the shell evolves toward more contextual presence, update executable contracts and canonical screenshots together rather than preserving a permanent control solely because it was previously approved.

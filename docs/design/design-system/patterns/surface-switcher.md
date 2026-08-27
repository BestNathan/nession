# SurfaceSwitcher

Web top-level toggle between **Terminal** and **Workspace** peer surfaces. Compact. Protects the xterm.js viewport.

## Purpose

Switch the active Session’s surface slot. Terminal is the default. Only one surface is visible.

This is **Web chrome**. It is not the App shell. App uses `Sessions ← Terminal → Workspace` ([interaction/app.md](../../interaction/app.md), [#473](https://github.com/BestNathan/nession/issues/473)).

Must not:

- Show Terminal and Workspace side-by-side as the default layout.
- Merge Workspace tools (Files \| Session \| Agent) into this control. That is [WorkspaceNavigation](workspace-navigation.md).
- Become a ModeBar-style pager of Terminal | Files | Envs (shipping predecessor).

## Anatomy

```text
[ Terminal | Workspace ]
        ▲         ▲
     default    auxiliary
```

Two mutually exclusive options. Selected option fills the Active Surface region under [SessionHeader](session-header.md).

Optional: keyboard shortcut (implementation-defined in #471). Must remain discoverable from the control itself (tooltip / aria).

## States

| State | Meaning |
|-------|---------|
| `terminal` | Terminal surface visible. Default after selecting a Session. |
| `workspace` | Workspace surface visible. Last Workspace tool remembered per Session is allowed. |

SurfaceSwitcher does **not** encode Agent / Session / attachment. Unhealthy Agent may still allow opening Workspace (e.g. cached AgentDetail) or may disable Files — that is tool `availability`, not a third segment on this control.

Disabled: if no Session is active, the switcher is absent or inert.

## Tokens

| Part | Tokens |
|------|--------|
| Track / selected | Semantic `surface.*`, `accent`; Domain `workspace.navigation` for the Workspace side if needed |
| Unselected | Semantic `text.secondary` |
| Size | Experience Web `control.sm` / `control.md` — compact, not `control.lg` |

No Primitive palette. No App Experience tokens in Web TSX (`experience.app.*`).

## Web vs App

| | Web | App |
|--|-----|-----|
| This pattern | Required in the session chrome | **Not used as the shell.** Do not ship a shrunken Terminal\|Workspace segmented control as the App IA |
| Terminal default | Yes | Yes (spatial center) |
| Alternative to switcher | — | Visible Workspace control + swipe-left; visible Sessions control + swipe-right |

App may reuse the *idea* of two surfaces, not this widget.

## Acceptance

- [ ] Exactly one of Terminal / Workspace is visible.
- [ ] Terminal is the default after Session select.
- [ ] Control is compact; Terminal viewport is not a persistent split with Files.
- [ ] Workspace tool tabs are a separate pattern (WorkspaceNavigation), not extra segments here.
- [ ] App slice does not implement this as a responsive copy of the Web header switcher.

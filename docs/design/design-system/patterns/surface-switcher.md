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

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and Web Active Terminal canonical screen ([#563](https://github.com/BestNathan/nession/pull/563)).

### Dominance

- SurfaceSwitcher is **secondary chrome** — compact, never taller or louder than [SessionHeader](session-header.md) title metadata.
- Terminal remains default and visually dominant in the shell; switching to Workspace hides Terminal — the switcher itself must not imply equal visual weight to both surfaces at rest.

### Information hierarchy

- **Primary action in header region (Web):** one of two peer labels — `Terminal` (default emphasis when selected) or `Workspace` (auxiliary).
- **Not present:** Agent status, tool tabs, or a third segment — those belong to other patterns.

### Alignment

- Inline in SessionHeader band or immediately beneath — trailing or centered per [composition.md](../../composition.md); never a full-width banner.

### Density

- Experience Web `control.sm` / `control.md` — **compact control density**, not `control.lg`.
- Two segments only; no wrapping label stack.

### Whitespace

- Minimal horizontal padding inside the track; whitespace separates the switcher from Session title — not an enclosing card.

### Contrast

- Selected segment: `primary` accent within the control — the only accent in this widget.
- Unselected: `secondary` text — no second accent color.

### Surface treatment

- Flat segmented control on header surface — no elevation, no shadow (healthy chrome never elevates, R-S5).
- Not a ModeBar-style multi-tab pager.

### State-driven emphasis

| State | Emphasis |
|-------|----------|
| `terminal` selected | Terminal segment `primary`; Workspace `secondary` |
| `workspace` selected | Workspace segment `primary`; user understands auxiliary surface |
| No active Session | Control absent or inert — not a disabled alarm state |
| Agent unhealthy | Does **not** add a third segment or recolor the switcher — tool `availability` is separate |

### Anti-patterns

- Terminal \| Workspace \| Files \| Agent as one control (ModeBar predecessor).
- Side-by-side Terminal + Workspace as default layout.
- App-shrunken copy of this widget as the spatial shell ([#473](https://github.com/BestNathan/nession/issues/473)).
- Large segmented control that steals vertical space from the Terminal well.
- Accent on both segments simultaneously.

### Canonical reference

- Web: `/#/fixture` 1440×900 — SurfaceSwitcher in terminal-native header ([#563](https://github.com/BestNathan/nession/pull/563)).
- App: **not used** — spatial model replaces this pattern ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Exactly one of Terminal / Workspace is visible.
- [ ] Terminal is the default after Session select.
- [ ] Control is compact; Terminal viewport is not a persistent split with Files.
- [ ] Workspace tool tabs are a separate pattern (WorkspaceNavigation), not extra segments here.
- [ ] App slice does not implement this as a responsive copy of the Web header switcher.

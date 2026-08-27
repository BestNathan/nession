# SessionHeader

Chrome for the **active Session**: identity plus always-available connection context.

## Purpose

Tell the user which Session they are in, and keep Agent/connection context at disclosure level 2 ([information-architecture.md](../../information-architecture.md)) — more explicit than the list row, less than [AgentDetail](agent-detail.md).

Must not replace [SurfaceSwitcher](surface-switcher.md) or become a second Session list.

## Anatomy

```text
┌─ SessionHeader ──────────────────────────────────────────┐
│ [ nav to Sessions ]  Session name                        │
│                      AgentContext     ConnectionStatus   │
│                      SurfaceSwitcher (Web)               │
└──────────────────────────────────────────────────────────┘
```

| Part | Role |
|------|------|
| Session title | Active Session name |
| Back / Sessions control | Web: optional if the list is already visible. **App: required visible control** to open the Sessions layer ([interaction/app.md](../../interaction/app.md)) |
| [AgentContext](agent-context.md) | Agent identity + quiet/prominent health |
| [ConnectionStatus](connection-status.md) | Three channels; may be compact in the header |
| [SurfaceSwitcher](surface-switcher.md) | Web only, in this header or immediately under it |
| Workspace control (App) | Visible control to open Workspace; not a shrink of SurfaceSwitcher |

Keep chrome compact so the Terminal viewport stays large.

## States

Header **contains** AgentContext and ConnectionStatus; it does not invent a fourth status.

| Header concern | Source |
|----------------|--------|
| Which Session | Session identity (name). Session `exited` / `unknown` may annotate the title via ConnectionStatus session channel |
| Can we reach the Agent | AgentContext + Agent channel of ConnectionStatus |
| Is this client attached | Attachment channel of ConnectionStatus |

When Agent is unhealthy, AgentContext grows visually **inside the header**; the title remains the Session name.

## Tokens

| Part | Tokens |
|------|--------|
| Bar background | Semantic `surface.1` / `surface.2` |
| Title | Semantic `text.primary` |
| Controls | Experience `control.*` |
| Unhealthy emphasis | Domain `agent.*` via AgentContext — not a Primitive red bar around the whole header unless Agent is `error`/`offline` |

## Web vs App

| | Web | App |
|--|-----|-----|
| Sessions access | List already in the left column | Visible control **and** swipe-right. Header is the primary non-gesture path |
| Surface switch | SurfaceSwitcher in/near header | No Terminal\|Workspace segmented control as the shell. Visible Workspace control + swipe-left |
| Height | Compact (Experience Web control/row) | Larger controls; respect safe area ([#473](https://github.com/BestNathan/nession/issues/473)) |

## Acceptance

- [ ] Header identifies the active Session by name.
- [ ] Agent context is always present, quiet when `agent.online`.
- [ ] App: Sessions and Workspace are reachable from visible header (or adjacent) controls.
- [ ] Header chrome does not permanently steal a Files sidebar.

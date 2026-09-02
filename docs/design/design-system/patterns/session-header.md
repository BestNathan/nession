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

## Visual Contract

Derived from [visual-language.md](../../visual-language.md), [composition.md](../../composition.md), and canonical screens ([#563](https://github.com/BestNathan/nession/pull/563), [#568](https://github.com/BestNathan/nession/pull/568)).

### Dominance

- **Session title is the only primary text** in the header band.
- [AgentContext](agent-context.md), [ConnectionStatus](connection-status.md), and switchers are secondary chrome — they must not outrank the title or steal area from the Terminal below.
- On App, the single-row header is navigation + context — not a second application shell.

### Information hierarchy

- **Primary:** Active Session name.
- **Secondary:** AgentContext identity, compact ConnectionStatus, SurfaceSwitcher (Web) or Workspace affordance (App).
- **Tertiary:** Healthy server/attachment fragments when shown at all.

### Alignment

- Web: title and metadata share the header band; controls right-aligned or trailing per [composition.md](../../composition.md).
- App: `[≡] Session name · status [☰]` single row — 44px touch band, safe-area top; Workspace page uses `[←] tool name` push header instead.

### Density

- **Compact chrome density** — minimum height that fits disclosure level 2 ([information-architecture.md](../../information-architecture.md)).
- Chrome density must not compress the Terminal viewport (R-D2).

### Whitespace

- Header is one horizontal band — no stacked card chrome.
- Vertical rhythm: header → work surface with minimal gap; terminal-native chrome stays flat.

### Contrast

- Title: `primary` / highest in chrome.
- Subcomponents follow their own Visual Contracts at `secondary`–`quiet`.
- No full-width danger treatment unless the header itself must signal attach failure — prefer channel-local emphasis.

### Surface treatment

- Flat `surface.1` / `surface.2` bar — no shadow, no card radius (healthy chrome never elevates, R-S5).
- Unhealthy Agent emphasis stays **inside** the header via AgentContext tint — not a red wrapper around the entire shell.

### State-driven emphasis

| Condition | Behavior |
|-----------|----------|
| Agent `online`, Session `active`, attached | All sub-patterns at `quiet` / default |
| Agent degraded | AgentContext + Agent channel escalate; **title unchanged** |
| Session `exited` | Title may annotate via Session channel — not replace name with error chrome |
| App navigation | Visible Sessions / Workspace controls always present — not gesture-only |

### Anti-patterns

- SessionHeader becoming a second Session list or Files sidebar.
- SurfaceSwitcher or App header duplicating floating spatial buttons (chrome dedup — [#568](https://github.com/BestNathan/nession/pull/568)).
- Permanent alarm bar for healthy connected state.
- Title and Agent name at equal weight.
- Header height that permanently consumes Terminal viewport.

### Canonical reference

- Web: `/#/fixture` 1440×900 — terminal-native header line above flush terminal well ([#563](https://github.com/BestNathan/nession/pull/563)).
- App: `/#/fixture/app` 390×844 — single-row header, no SurfaceSwitcher, no duplicated FABs ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Header identifies the active Session by name.
- [ ] Agent context is always present, quiet when `agent.online`.
- [ ] App: Sessions and Workspace are reachable from visible header (or adjacent) controls.
- [ ] Header chrome does not permanently steal a Files sidebar.

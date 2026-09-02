# AgentContext

Always-available Agent infrastructure chrome at disclosure level 2. Visually **quiet when healthy**; **prominent when not**.

## Purpose

Show which Agent this Session is reached through, and whether that proxy is healthy — without making Agent the navigation object.

Progressive disclosure ([information-architecture.md](../../information-architecture.md)):

1. [SessionItem](session-item.md) — compact metadata  
2. **AgentContext (this pattern)** — explicit, still compact  
3. [AgentDetail](agent-detail.md) — full details  

Click/tap on AgentContext (when healthy enough to navigate) should open Workspace → Agent tool, not an Agent-first dashboard.

## Anatomy

```text
Healthy (quiet):

  [·]  devbox-01

Unhealthy (prominent):

  [!]  devbox-01  Agent offline
```

| Part | Role |
|------|------|
| Indicator | Domain-colored mark for Agent connection only |
| Agent identity | Display name / host |
| Status phrase | Present when not `online`; omitted or de-emphasized when `online` |
| Afford to AgentDetail | Opens Workspace Agent tool (Web) or pushes AgentDetail (App stack) |

Do not list this Agent’s other Sessions here. That would recreate Agent-grouped navigation.

## States

**This pattern renders Agent connection only.** Session lifecycle and attachment belong on [ConnectionStatus](connection-status.md). AgentContext may sit next to ConnectionStatus in the header but must not absorb those channels into its indicator.

| Agent | Visual weight | Phrase (examples) |
|-------|---------------|-------------------|
| `online` | Quiet: low-contrast indicator or none beyond identity | Identity only |
| `connecting` | Medium | “Connecting to Agent” |
| `reconnecting` | Medium–high | “Agent reconnecting” |
| `offline` | High | “Agent offline” / “Agent unreachable” |
| `error` | High | “Agent error” |

Forbidden phrases as the sole explanation: “Session offline”, “Session failed”, “Disconnected” with no Agent/attachment distinction.

## Tokens

| Part | Tokens |
|------|--------|
| Identity | Semantic `text.secondary` when healthy; `text.primary` when prominent |
| Indicator | Domain `agent.online` \| `agent.connecting` \| `agent.reconnecting` \| `agent.offline` \| `agent.error` |
| Unhealthy container | Optional Domain `agent.offline` / `agent.error` border or surface tint — still header-scale, not a full-screen modal |

Never Primitive `border-green-500/30` on the healthy state (shipping `AgentCard` predecessor).

## Web vs App

Same quiet/prominent rule on both.

| | Web | App |
|--|-----|-----|
| Placement | Inside [SessionHeader](session-header.md) | Same |
| Open details | SurfaceSwitcher → Workspace if needed, then Agent tool — or jump to Agent tool | Push AgentDetail on the Workspace navigation stack; must not steal top-level `Sessions ← Terminal → Workspace` gestures |
| Touch | Compact | `touchTarget.min` on the tappable identity |

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and the Web Active Terminal canonical screen ([#563](https://github.com/BestNathan/nession/pull/563)).

### Dominance

- Agent identity is **secondary metadata** in every context this pattern appears — never the row's hero.
- When `agent.online`, this pattern must not be the loudest element in [SessionHeader](session-header.md) or [SessionItem](session-item.md).

### Information hierarchy

- **Primary:** Agent display name / host when the user needs to know *where* the Session runs.
- **Secondary:** Status phrase when Agent is not `online`.
- **Tertiary:** Healthy indicator (dot or none) — present only if it adds disambiguation; often omitted entirely when `online`.

### Alignment

- Inline with Session title row in the header; left-aligned with other header metadata.
- On App, vertically centered in the single-row header band ([composition.md](../../composition.md) §9).

### Density

- **Compact / metadata density** — one line, no wrapping in the header compact form.
- App: tappable hit area meets `touchTarget.min` without inflating header height.

### Whitespace

- No padded card around healthy AgentContext. Identity sits in the header's natural rhythm.
- Unhealthy states may add a local tint or compact badge — still header-scale, not a banner.

### Contrast

- Healthy: `quiet` / `tertiary` — identity at secondary text contrast ([visual-language.md](../../visual-language.md) R-E1).
- Unhealthy: `conditional-prominent` — phrase and indicator jump one or two emphasis levels; Session title stays `primary`.

### Surface treatment

- No bordered card, no elevation, no full-width danger bar in the header.
- Optional Domain tint on the identity cluster only when `offline` / `error` — background shift preferred over border.

### State-driven emphasis

| Agent | Emphasis | Treatment |
|-------|----------|-----------|
| `online` | `quiet` | Identity only; no status phrase; no green badge |
| `connecting` / `reconnecting` | `conditional-prominent`, medium | Short phrase; subtle indicator |
| `offline` / `error` | `conditional-prominent`, high | Phrase + Domain tint; names **Agent** |

Session lifecycle and attachment **never** change AgentContext's indicator — those channels stay on [ConnectionStatus](connection-status.md).

### Anti-patterns

- Green border or glow on healthy Agent (`border-green-500/30` — shipping `AgentCard` predecessor).
- "Session offline" / "Disconnected" as the sole phrase with no Agent distinction.
- Listing other Sessions for this Agent (recreates Agent-first navigation).
- Full-header red bar when only Agent connectivity is degraded.
- Equal contrast for identity and alarm phrase when `online`.

### Canonical reference

- Web: Active Terminal fixture `/#/fixture` at 1440×900 — header AgentContext on selected Session ([#563](https://github.com/BestNathan/nession/pull/563)).
- App: `/#/fixture/app` at 390×844 — compressed identity in single-row header ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Healthy Agent is visually quiet (identity without alarm chrome).
- [ ] Offline/reconnecting/error is prominent and names **Agent**.
- [ ] Does not display Session lifecycle or attachment as its own indicator.
- [ ] Affordance leads to Agent details, not to an Agent session list as primary nav.

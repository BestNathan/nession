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

## Acceptance

- [ ] Healthy Agent is visually quiet (identity without alarm chrome).
- [ ] Offline/reconnecting/error is prominent and names **Agent**.
- [ ] Does not display Session lifecycle or attachment as its own indicator.
- [ ] Affordance leads to Agent details, not to an Agent session list as primary nav.

# SessionItem

One row in [SessionList](session-list.md): a Session, with Agent as **secondary metadata**.

## Purpose

Identify a Session at a glance (name, workload hint, which Agent, recency) and show whether the user can reach it **without** claiming the Session itself is “offline” when only the Agent is unreachable.

## Anatomy

```text
┌─ SessionItem ─────────────────────────────────────────────┐
│ ●  Fix terminal reconnect                                 │  name + recency/activity mark
│    Claude Code · devbox-01 · 2m                           │  workload · Agent · recency
└───────────────────────────────────────────────────────────┘
```

| Part | Content | Notes |
|------|---------|--------|
| Selection affordance | Highlight / bar when this is the active Session | Not an Agent selection |
| Session name | Primary text | Truncate; name is the object |
| Workload hint | e.g. Claude Code, Codex, zsh | Hint only. Not an IA type. Unknown/generic workload is fine (e.g. `shell`) |
| Agent identity | Display name or host id (`devbox-01`) | Metadata, not a link that replaces Session navigation |
| Recency | Relative last activity | |
| Reachability | Quiet when Agent `online`; prominent when Agent is not healthy | See States. Copy must name **Agent**, not Session offline |

Optional trailing actions (preview, kill) must not dominate the row. Destructive actions use a confirm pattern (AlertDialog on Web).

## States

Map independently. A single row color/dot **must not** encode all three.

### Agent connection (reachability)

| Agent | Presentation | Copy (normative examples) |
|-------|----------------|---------------------------|
| `online` | Quiet. No extra badge required. | — |
| `connecting` / `reconnecting` | Subtle Agent-side indicator | “Agent reconnecting” — not “Session reconnecting” unless attachment is also in flight |
| `offline` | Prominent on the metadata line or a compact badge | “Agent unreachable” / “Agent offline”. **Forbidden:** “Session offline”, “Session failed” as the only message |
| `error` | Prominent, `agent.error` | “Agent error” |

When Agent is `offline` and Session last-known is `active`: the row **stays**. Show Agent connectivity problem. Do not hide or grey the Session name as if it were `exited`.

### Session lifecycle

| Session | Presentation |
|---------|----------------|
| `active` | Normal name weight |
| `exited` | Secondary treatment; still a Session row if it remains in the list |
| `unknown` | Neutral; do not invent `exited` |

### Attachment (this client)

| Attachment | Presentation |
|------------|----------------|
| `attached` | Optional quiet mark that *this client* is attached (not “Session running”) |
| `attaching` | Transient; do not reuse Agent `connecting` chrome |
| `detached` | Default for a listed Session the user is not in |
| `failed` | Attachment failure copy, distinct from Agent `error` |

Shipping predecessor paints `session.status === 'active' | 'detached' | 'zombie'` as one dot. The v2 row must not revive that collapse.

## Tokens

| Part | Tokens |
|------|--------|
| Name | Semantic `text.primary` |
| Metadata line | Semantic `text.secondary` |
| Selected row | Semantic surface/accent |
| Agent healthy | Domain `agent.online` only if an indicator is shown; otherwise inherit quiet metadata |
| Agent not healthy | Domain `agent.offline` / `agent.reconnecting` / `agent.error` |
| Session exited | Domain `session.exited` (name/metadata, not the Agent badge) |
| This-client attached | Domain `attachment.attached` |
| Row height | Experience `row.*` |

No Primitive `bg-green-500` / `bg-gray-400` dots.

## Web vs App

Same information hierarchy on both: name first, metadata second.

| | Web | App |
|--|-----|-----|
| Hit target | Experience Web row | `touchTarget.min` |
| Secondary actions | Icon buttons / overflow | Prefer swipe actions or overflow; keep kill behind confirm |
| Agent prominence when unhealthy | Metadata line or compact badge | Same, larger type allowed; still not an Agent header |

## Acceptance

- [ ] Row represents a Session, not an Agent.
- [ ] Metadata includes workload hint, Agent identity, recency.
- [ ] Agent `offline` + Session still listed → copy blames Agent connectivity, not Session death.
- [ ] Selection state is visible.
- [ ] No single chromatic dot stands for Agent + Session + attachment together.

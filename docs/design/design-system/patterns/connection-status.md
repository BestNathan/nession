# ConnectionStatus

Atom for **independent** presentation of the three domain dimensions. Other patterns compose it; they must not invent a fused “session.running / session.failed” light.

## Purpose

Make Agent connection, Session lifecycle, and this-client attachment readable as three facts ([product-model.md](../../product-model.md), [tokens.md](../tokens.md)).

Used compactly in [SessionHeader](session-header.md) / [AgentContext](agent-context.md) neighbors, and more explicitly in [AgentDetail](agent-detail.md). [SessionItem](session-item.md) may use a reduced form for reachability.

## Anatomy

Three **channels**. Compact header form may show one line with three labeled fragments; detail form may stack them.

```text
Compact:

  Agent  online    Session  active    Attached

Detail:

  Agent connection    online
  Session             active
  This client         attached
```

| Channel | Dimension | Allowed values |
|---------|-----------|----------------|
| Agent | Agent connection | `online` `connecting` `reconnecting` `offline` `error` |
| Session | Session lifecycle | `active` `exited` `unknown` |
| Attachment | This client | `attached` `attaching` `detached` `failed` |

Each channel has a label (or accessible name) so a color-only encoding is not the only signal.

## States

### Canonical example (normative)

Agent `offline`, Session last-known `active`, attachment `detached` or `failed`:

| Channel | Value | UI |
|---------|-------|-----|
| Agent | `offline` | Prominent; “Agent offline” / “Agent unreachable” |
| Session | `active` or `unknown` | Neutral; **not** painted as failed |
| Attachment | `detached` / `failed` | “Not attached” / “Attach failed” — not “Session offline” |

The user must be able to tell this is an **Agent connectivity** problem.

### Other combinations (illustrative)

| Agent | Session | Attachment | Reading |
|-------|---------|------------|---------|
| `online` | `active` | `attached` | Healthy working state; Agent channel quiet |
| `online` | `active` | `detached` | Session exists; this client is not in it |
| `online` | `exited` | `detached` | Session ended; Agent is fine |
| `online` | `active` | `attaching` | Attach in flight; do not reuse Agent `connecting` chrome |
| `reconnecting` | `active` | `attached` | Keep Session+attachment; Agent channel prominent |
| `error` | `unknown` | `failed` | All three visible; still three labels |

## Tokens

| Channel | Domain tokens |
|---------|-----------------|
| Agent | `agent.online` `agent.connecting` `agent.reconnecting` `agent.offline` `agent.error` |
| Session | `session.active` `session.exited` `session.unknown` |
| Attachment | `attachment.attached` `attachment.attaching` `attachment.detached` `attachment.failed` |

Labels: Semantic `text.secondary`. Values: corresponding Domain token (and Semantic `success` / `warning` / `danger` only as the Semantic parent of those Domain tokens, never a Primitive class in product TSX).

**Forbidden:** one `bg-green-500` / `bg-gray-400` dot for the whole widget.

## Web vs App

Same three channels and copy rules.

| | Web | App |
|--|-----|-----|
| Compact | Header-scale | Header-scale with `touchTarget` if tappable to expand |
| Detail | AgentDetail section | AgentDetail section |
| Color + text | Both required | Both required (gestures do not replace status text) |

## Acceptance

- [ ] Three channels are labeled (visually or via accessible name).
- [ ] Agent offline + Session still present does not render as a single “Session offline”.
- [ ] Attachment `failed` is distinct from Agent `error`.
- [ ] No Primitive palette classes on the indicators.

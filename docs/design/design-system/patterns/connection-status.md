# ConnectionStatus

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [information architecture](../../information-architecture.md)

ConnectionStatus is a reusable state pattern for presenting **independent continuity dimensions without collapsing them into one generic status**.

It does not require all dimensions to be permanently visible. It shows the smallest set of state that matters to the current work and reveals deeper detail on demand.

## Purpose

Preserve semantic truth when Nession needs to explain why work is reachable, degraded, detached, or ended.

Current dimensions are:

```text
Agent / Workspace Location connectivity
Session lifecycle
this-client attachment
```

These facts can coexist independently.

## Contextual presentation

The full model may contain all three dimensions, but the UI should not automatically render three badges everywhere.

```text
healthy + redundant
    -> may show nothing

one degraded dimension
    -> show that affected dimension

ambiguous recovery / explicit detail
    -> show two or three labeled dimensions
```

Examples:

- Agent offline, Session last-known active, client detached → surface the infrastructure problem; do not label the Session dead.
- Agent online, Session exited → surface Session lifecycle; no need for a green Agent badge.
- Agent online, Session active, attachment failed → explain attach failure; do not call it an Agent outage.
- Explicit Agent/Location detail → all applicable dimensions may be shown for diagnosis.

## Canonical states

### Infrastructure / location connectivity

Current Agent-backed values:

```text
online
connecting
reconnecting
offline
error
```

### Session lifecycle

```text
active
exited
unknown
```

### This-client attachment

```text
attached
attaching
detached
failed
```

Do not infer one dimension from another unless the underlying system actually provides that guarantee.

## Disclosure levels

A useful model is:

1. **implicit healthy state** — no status chrome when nothing needs attention;
2. **contextual state** — one concise phrase/indicator near affected work;
3. **expanded status** — labeled dimensions when ambiguity/recovery requires them;
4. **diagnostic detail** — evidence/history/provider facts in a deeper view such as AgentDetail.

This pattern exists to reduce both semantic ambiguity and permanent status noise.

## Anatomy

Compact contextual form:

```text
Agent reconnecting
```

Expanded form when needed:

```text
Agent / Location    offline
Session             active (last known)
This client          detached
```

Each visible value must retain a label or accessible semantic name. Color alone is never sufficient.

## State-driven emphasis

| Condition | Emphasis |
|-----------|----------|
| Healthy, no ambiguity | hidden or quiet |
| Transient reconnect / attaching | medium, local |
| Continuity-threatening failure | prominent on the affected dimension |
| Explicit diagnostics | all applicable channels readable, but only degraded facts use alarm emphasis |

Do not promote healthy `online` / `attached` states merely to prove that the system works.

## Location / Agent evolution

The current executable Domain vocabulary uses `agent.*`, because today's transport is Agent-backed. Product semantics should be read as execution/location connectivity rather than as a requirement that every future Workspace Location expose a visible Agent object.

If future providers require distinct state semantics, evolve the Domain vocabulary deliberately while preserving dimension independence.

## Tokens

| Dimension | Current Domain tokens |
|-----------|-----------------------|
| Agent-backed connectivity | `agent.online` `agent.connecting` `agent.reconnecting` `agent.offline` `agent.error` |
| Session | `session.active` `session.exited` `session.unknown` |
| Attachment | `attachment.attached` `attachment.attaching` `attachment.detached` `attachment.failed` |

Labels use Semantic text tokens. Product components must not consume Primitive palette classes directly.

A token existing does not require a visible badge.

## Web vs App

Same semantic model, different presentation density.

| | Web | App |
|--|-----|-----|
| Contextual status | inline metadata / banner / local affordance | compact row / banner / local affordance |
| Expanded status | popover, panel, Workspace detail | sheet / push view / Workspace detail |
| Healthy dimensions | may be omitted | may be omitted |
| Touch | pointer behavior as appropriate | tappable disclosure meets touch target |

## Relationship to other patterns

- [SessionItem](session-item.md) may show one affected dimension when it helps the user choose/return to work.
- [SessionHeader](session-header.md) may show continuity-critical state when useful.
- [AgentContext](agent-context.md) focuses only infrastructure/location connectivity.
- [AgentDetail](agent-detail.md) may show an expanded diagnostic form.

None of those patterns must always render the complete ConnectionStatus model.

## Visual contract

### Dominance

- Healthy status should never compete with current work.
- Only the affected dimension gains conditional prominence.
- Expanded diagnostic forms can be denser because the user explicitly requested them.

### Surface treatment

- Compact form prefers text/indicator in existing context rather than three pills/cards.
- Avoid decorative success surfaces.
- Use the weakest sufficient warning/error treatment.

## Anti-patterns

- One dot or badge encoding Agent + Session + attachment.
- Always showing three channels simply because the model has three dimensions.
- Permanent `online`/`attached` success badges in routine work.
- `Session offline` when only Agent/location reachability failed.
- Color-only status with no semantic label/accessibility name.
- Inferring Session death from an infrastructure outage.
- Making every provider implement Agent-specific UI terminology forever.

## Acceptance for future implementation work

- [ ] Independent state dimensions remain semantically separate.
- [ ] Healthy/redundant status may disappear.
- [ ] A degraded dimension can surface alone without forcing unrelated badges to appear.
- [ ] Expanded detail labels every applicable dimension clearly.
- [ ] Infrastructure failure does not falsely redefine Session lifecycle.
- [ ] Current `agent.*` implementation can evolve toward broader Workspace Location/provider semantics.

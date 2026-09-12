# SessionItem

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [information architecture](../../information-architecture.md)

SessionItem represents one Session in Session navigation. It helps the user recognize and return to work without making infrastructure or tool identity the primary object.

## Purpose

Answer, at a glance:

- which work/session is this;
- what kind of workload is happening there, when useful;
- where it is running, when that helps distinguish it;
- how recent it is;
- whether a reachability/lifecycle issue needs attention.

The Session name remains the primary identity.

## Contextual anatomy

```text
Fix terminal reconnect
Claude Code · devbox-01 · 2m
```

Possible parts:

| Part | Role |
|------|------|
| Session name | Primary work identity |
| Workload hint | Optional hint such as Claude Code, Codex, zsh; never an IA type |
| Location / Agent hint | Optional execution-context metadata when useful for disambiguation |
| Recency | Optional last-activity signal |
| Selection | Shows the active Session |
| Degraded state | Local, explicit signal only when continuity is affected |
| Secondary actions | Progressive-disclosure actions such as rename/kill |

Do not force every row to show every metadata fragment. If six rows are all on the same healthy Location, repeating the Agent name six times may add no value.

## Metadata priority

Apply the principle "show only what matters now":

1. Session identity is always the strongest signal.
2. Workload/location/recency are supporting hints and may be omitted when redundant.
3. Degraded reachability or lifecycle state may temporarily outrank routine metadata.
4. Destructive actions stay hidden until hover/focus/selection/explicit overflow.

## Workload semantics

A workload hint can be inferred from foreground process or integration state, but it is not a permanent Session type.

```text
shell
Claude Code
Codex
OpenCode
vim
other TUI / process
unknown
```

An active coding-agent capability may gain contextual presence elsewhere in the Session. The SessionItem only needs enough hint to help recognition; it should not become a mini capability dashboard.

## Location / Agent semantics

Long term, execution context belongs to Workspace Location/provider semantics. Today Agent identity is a common source.

The row should therefore conceptually present **where this work is running**, not imply that Agent is the parent of the Session.

Location/Agent metadata may be:

- shown when Sessions span different machines/environments;
- shown when a connectivity problem affects this Session;
- hidden when redundant;
- replaced by a more user-meaningful Workspace Location label as the product model evolves.

## Independent state dimensions

Do not collapse infrastructure connectivity, Session lifecycle, and this-client attachment into one colored dot.

### Infrastructure / location reachability

| State | Presentation |
|-------|--------------|
| Healthy | Usually quiet or omitted |
| Connecting / reconnecting | Short contextual phrase when it affects entry |
| Offline / error | Explicit local signal such as `Agent unreachable` / `Location unreachable` |

### Session lifecycle

| State | Presentation |
|-------|--------------|
| `active` | Normal Session identity |
| `exited` | Secondary treatment; row can remain if useful/history allows |
| `unknown` | Neutral; do not invent failure |

### This-client attachment

Attachment is usually not useful on every inactive row. Show it only where it clarifies current state, such as attach-in-progress or attach failure.

An Agent being offline does not prove the Session exited. A detached client does not prove the Session stopped.

## Visual contract

### Dominance

- Session name is the only normal high-emphasis text.
- Supporting metadata shares a quieter band.
- One degraded fact may gain local emphasis without turning the whole row into an alarm card.

### Density

Rows should remain highly scannable. Prefer two concise lines over multiple badges, chips, and icons.

Web can use compact navigation density; App must preserve touch targets without inflating every metadata element.

### Surface treatment

- Flat list rows, not nested cards.
- Selection uses one coherent cue.
- Healthy state needs no green success badge.
- Per-capability branding should not color the row.

## Progressive disclosure

Secondary actions and technical detail should not occupy permanent row width.

```text
rest
    -> identify work

hover / focus / selection
    -> small actions

degraded
    -> affected state becomes visible

explicit detail
    -> deeper Session / Location / capability information
```

## Tokens

| Part | Tokens |
|------|--------|
| Session name | Semantic `text.primary` |
| Metadata | Semantic `text.secondary` / `text.tertiary` |
| Selection | Semantic accent/surface |
| Infrastructure failure | current `agent.*` Domain state where Agent-backed |
| Session lifecycle | `session.*` |
| Attachment | `attachment.*` when shown |
| Row density | Experience `row.*` / App touch-target tokens |

Do not use Primitive palette colors directly.

## Web vs App

The semantic hierarchy remains the same.

| | Web | App |
|--|-----|-----|
| Density | Compact, scan-oriented | Touch-safe, still concise |
| Secondary actions | Hover/focus/overflow | Overflow/swipe/context action |
| Metadata | May fit one secondary line | May truncate/reduce before adding vertical chrome |
| Session navigation | Often list/sidebar/drawer depending current Web composition | Spatial Sessions layer |

## Anti-patterns

- Agent as a section header/navigation parent for every Session.
- Equal visual weight for Session name, Agent, workload, recency, and status.
- Always showing healthy Agent/location metadata even when redundant.
- One chromatic dot representing Agent + Session + attachment.
- `Session offline` when only infrastructure reachability is known to have failed.
- Permanent destructive controls.
- Extension-specific badges accumulating until the row becomes a plugin strip.
- Treating `Claude Code`, `Codex`, etc. as permanent Session types that redefine navigation.

## Acceptance for future implementation work

- [ ] Session identity remains the primary row signal.
- [ ] Workload and execution context are optional supporting metadata, not navigation parents.
- [ ] Redundant healthy metadata can disappear.
- [ ] Degraded infrastructure/lifecycle/attachment states remain semantically distinct.
- [ ] Capability growth does not cause proportional badge growth in Session rows.
- [ ] Destructive/secondary actions use progressive disclosure.
- [ ] The pattern can evolve from Agent labels toward Workspace Location/provider labels without changing its product role.

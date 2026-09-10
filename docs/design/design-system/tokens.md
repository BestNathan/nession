# Design Tokens (architecture)

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [visual language](../visual-language.md)

Executable tokens, codegen, and lint live in [#467](https://github.com/BestNathan/nession/issues/467). This document records the **vocabulary and layering constraints** so executable styling follows product meaning instead of freezing accidental shell structure.

## What tokens do — and do not do

Tokens encode reusable visual/state values. They do **not** define information architecture or decide capability presence.

`Sessions ← Terminal → Workspace`, contextual capability emergence, or whether a control is visible are product/interaction rules. They belong in product model, IA, interaction, pattern, and contract layers — not in color/spacing token names.

## Layer stack

```text
Primitive
    ↓
Semantic
    ↓
Domain
    ↓
Experience (Web / App)
    ↓
Pattern / component
```

Product UI must not consume Primitive palette values directly.

Web and App share Primitive, Semantic, and Domain meaning. They specialize at Experience for density, touch/pointer behavior, safe areas, and control sizing. Do not create two independent design systems.

## Core Domain vocabulary

Current shared vocabulary follows [product-model.md](../product-model.md) and keeps independent state dimensions separate.

```text
agent.online
agent.connecting
agent.reconnecting
agent.offline
agent.error

session.active
session.exited
session.unknown

attachment.attached
attachment.attaching
attachment.detached
attachment.failed

terminal.background
terminal.foreground
terminal.selection
terminal.cursor

workspace.background
workspace.surface
workspace.navigation

file.selected
file.modified
file.created
file.deleted

editor.background
editor.gutter
editor.activeLine
```

The `agent.*` family reflects today's Agent-backed infrastructure implementation. The product model already allows Workspace Locations and future providers, so code must not interpret `agent.*` as proof that Agent is the permanent top-level product object.

If broader location/provider state becomes independently user-visible, add deliberate Domain semantics rather than overloading unrelated tokens.

## Capability and extension tokens

Nession's core token vocabulary should remain workload-agnostic, but extensions may need domain-specific state.

The rule is:

> Extension-specific tokens may describe a capability's own semantic state, but they must not redefine Nession's global hierarchy, navigation, or visual language.

For example, a Claude Code extension may eventually need semantic state for a running task or conversation. That should be scoped as extension/capability semantics and map back through shared Semantic values. It should not make universal core tokens such as `session.thinking` or force every Session into an AI-chat model.

Avoid universal AI-runtime semantics unless Nession itself truly owns them across workloads.

## Contextual presence is not a token state machine

The product capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

That vocabulary guides presence and interaction. It should not automatically become four colors.

In particular:

- `available` is usually visually quiet;
- `relevant` may change presence before color;
- `active` does not imply accent saturation;
- absence/visibility is generally a composition or contract concern, not a palette concern.

This prevents the design system from turning every capability state into decorative badges.

## Constraints for executable tokens

- Agent/location connectivity, Session lifecycle, and client attachment must not collapse into one generic status.
- Light/dark themes resolve Semantic tokens to Primitive values; product UI consumes Semantic / Domain / Experience.
- Product patterns and extension views should prefer shared Semantic meaning before adding new Domain vocabulary.
- Do not create token names for one-off layout decisions simply to avoid writing composition rules.
- Do not encode permanent-navigation assumptions in tokens (`workspace.toolTab.active`, `agentSidebar.width`, etc.) unless the underlying product relationship is truly stable and canonical.
- CSS is an output/consumer, not the product source of truth. App may not consume CSS at all.

Example legal chain:

```text
color.green.500
      ↓
success
      ↓
agent.online
      ↓
AgentContext / connectivity detail
```

Never:

```text
color.green.500 -> product component
```

And avoid treating the chain above as a requirement to visibly render `agent.online`; healthy state may be intentionally absent under the product Principles.

## Experience vs product structure

| Belongs in tokens | Belongs in higher-level design |
|-------------------|--------------------------------|
| `agent.online` color mapping | Whether healthy Agent context is visible at all |
| `experience.web.control.md` | Whether Web uses a switcher, menu, overlay, or contextual entry |
| `experience.app.touchTarget.min` | `Sessions ← Terminal → Workspace` interaction model |
| `workspace.surface` | What Workspace shows in the current context |
| composer spacing / radius | Whether a capability earns capsule presence |

Tokens make an approved composition consistent; they do not approve the composition.

## Source of truth

```text
design/tokens/          platform-neutral token source
design/generated/       derived CSS / TS / lint metadata — never hand-edit
design/contracts/       measurable UI contracts; see [contracts.md](contracts.md)
docs/design/            product/IA/interaction/pattern/validation architecture
```

Precedence remains:

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
executable tokens / contracts
    ↓
implementation
```

When an old executable token or contract encodes a superseded product assumption, update the lower layer; do not weaken the upstream product model to preserve generated output.

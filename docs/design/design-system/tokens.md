# Design Tokens (architecture)

Executable tokens, codegen, and lint live in [#467](https://github.com/BestNathan/nession/issues/467). This document records the **vocabulary and layering constraints** so #467 stays aligned with the product model.

IA and interaction patterns themselves are **not** tokens. `Sessions ← Terminal → Workspace` is an App interaction pattern ([interaction/app.md](../interaction/app.md)), not a color or spacing token. Workspace tool hierarchy belongs in [workspace.md](../workspace.md) and pattern specs ([#470](https://github.com/BestNathan/nession/issues/470)).

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
Component / Pattern
```

Components and patterns must not consume Primitive tokens directly.

Web and App share Primitive, Semantic, and Domain. They specialize at Experience (density, control size, pointer vs touch, sheets, safe area). Do not create two independent design systems.

## Domain vocabulary

Domain names follow [product-model.md](../product-model.md). Keep the three state dimensions separate.

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

Shared Domain vocabulary centers on `agent.*`, `session.*`, `attachment.*`, `terminal.*`, `workspace.*`, `file.*`, and `editor.*`.

## Constraints for #467

- Nession is not an Agent runtime. Agent tokens represent the remote tmux proxy / connection endpoint, not an AI assistant.
- Do **not** introduce AI-runtime semantics such as `agent.thinking`, `tool.running`, `stream.agent` unless Nession later explicitly owns that domain.
- Agent connection, Session lifecycle, and attachment **must not** collapse into one generic Session status.
- Light/dark themes resolve Semantic tokens to Primitive values; product UI consumes Semantic / Domain / Experience, not palette literals.
- CSS is not the canonical source (App may not consume CSS). Pattern/IA documentation stays in `docs/design/`, not in the token JSON.

Example of a legal chain:

```text
color.green.500
      ↓
success
      ↓
agent.online
      ↓
ConnectionStatus / AgentContext
```

Never: `color.green.500 → product component`.

## Experience vs IA

| Belongs in tokens (#467) | Belongs in this architecture |
|--------------------------|------------------------------|
| `agent.online` color mapping | Agent is not the navigation parent |
| `experience.web.control.md` | Terminal \| Workspace peer surfaces |
| `experience.app.touchTarget.min` | `Sessions ← Terminal → Workspace` |
| `workspace.navigation` surface color | Files master/detail is local to Files |

## Source of truth (proposed)

Exact paths may follow repository conventions when #467 lands. Responsibilities:

```text
design/tokens/          platform-neutral source (primitive, semantic, domain, experience)
design/generated/       derived CSS / TS / lint metadata — do not edit by hand
docs/design/            this architecture (IA, interaction, patterns)
```

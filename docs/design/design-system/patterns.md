# Patterns

Nession-specific composition is documented as **patterns**: assemblies of [primitives](components.md) that encode product IA and interaction.

Full interaction specifications for each pattern are [#470](https://github.com/BestNathan/nession/issues/470). This document names the pattern layer and its relationship to the architecture.

## Pattern catalog

```text
SessionList
SessionItem
SessionHeader
AgentContext
SurfaceSwitcher
WorkspaceNavigation
ConnectionStatus
FileWorkspace
AgentDetail
```

| Pattern | Architecture role |
|---------|-------------------|
| SessionList / SessionItem | Flat primary navigation; Agent as compact secondary metadata ([information-architecture.md](../information-architecture.md)) |
| SessionHeader / AgentContext | Always-available connection context; quiet when healthy, prominent when not |
| SurfaceSwitcher | Terminal \| Workspace peer surfaces; one visible at a time (Web: [interaction/web.md](../interaction/web.md)) |
| WorkspaceNavigation | Tool-level nav (Files \| Session \| Agent \| …) without a permanent inner sidebar ([workspace.md](../workspace.md)) |
| ConnectionStatus | Renders **Agent connection** independently of Session lifecycle and attachment ([product-model.md](../product-model.md)) |
| FileWorkspace | Files tool master/detail; not the Workspace shell |
| AgentDetail | Workspace → Agent complete details |

App spatial navigation (`Sessions ← Terminal → Workspace`) is an interaction model ([interaction/app.md](../interaction/app.md)), realized with native layers plus these patterns — not a separate primitive.

## Rules

- Patterns may know domain concepts (Session, Agent, attachment). Primitives may not.
- Patterns consume Domain / Semantic / Experience tokens, never Primitive palettes ([tokens.md](tokens.md)).
- A pattern must not collapse Agent connection, Session state, and attachment into one status display.
- Adding a future Workspace tool should register with WorkspaceNavigation, not require a new top-level pattern unless the tool introduces a new composition (as Files does with FileWorkspace).

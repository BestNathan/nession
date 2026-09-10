# Patterns

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [information architecture](../information-architecture.md) → [interaction](../interaction/) → [visual language](../visual-language.md)

Nession patterns are reusable assemblies of generic UI primitives that encode product semantics and interaction. They are downstream implementations of the product contract, not a second source of product direction.

**Spec issue:** [#470](https://github.com/BestNathan/nession/issues/470)
**Tokens:** [tokens.md](tokens.md) — patterns consume Semantic / Domain / Experience tokens.
**Contracts:** measurable rules live in [contracts.md](contracts.md) / `design/contracts/`; enforcement lives in [validation.md](validation.md).

## Product rule for patterns

A reusable pattern should help Nession add capability without adding proportional permanent chrome.

Patterns therefore distinguish **capability contribution** from **capability placement**. A feature or extension can expose state, actions, and a deeper view without automatically earning a tab, button, or sidebar entry.

The generic capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

Patterns that display capabilities must respect that lifecycle and progressive disclosure.

## Catalog

| Pattern | Spec | Role |
|---------|------|------|
| [SessionList](patterns/session-list.md) | navigation | Primary work navigation; flat by default |
| [SessionItem](patterns/session-item.md) | row | Session identity, compact workload/location metadata, recency, reachability |
| [SessionHeader](patterns/session-header.md) | chrome | Quiet context for the active Session |
| [AgentContext](patterns/agent-context.md) | context | Infrastructure identity/state; quiet when healthy |
| [SurfaceSwitcher](patterns/surface-switcher.md) | optional Web affordance | One possible explicit Terminal ↔ Workspace control; not a product invariant |
| [WorkspaceNavigation](patterns/workspace-navigation.md) | contextual navigation | Reach resources/capabilities relevant to the current Workspace; not a permanent tool catalog |
| [ConnectionStatus](patterns/connection-status.md) | state | Independent infrastructure / Session / attachment presentation |
| [FileWorkspace](patterns/file-workspace.md) | capability view | Files-specific master/detail composition |
| [AgentDetail](patterns/agent-detail.md) | detail | Infrastructure/location detail |
| [TerminalCapsule](patterns/terminal-capsule.md) | interaction | Conversational/contextual interaction surface over the Terminal |
| [TerminalSurface](patterns/terminal-surface.md) | work surface | xterm well, focus, scroll, clearance, attachment lifecycle |

The catalog is not a mandatory shell anatomy. Each pattern is used only when the current product context justifies it.

## Pattern contract

Every product pattern should document:

1. **Purpose** — the user job it serves and what it must not become.
2. **Product context** — where it sits relative to current work, Session, Workspace, and capability state.
3. **Anatomy** — semantic parts rather than accidental current DOM structure.
4. **States** — domain/capability states it represents without collapsing independent dimensions.
5. **Progressive disclosure** — what is visible at rest and what appears only after relevance or explicit intent.
6. **Tokens** — Semantic / Domain / Experience names; no private visual language per feature.
7. **Web vs App** — shared meaning with experience-specific presentation.
8. **Visual Contract** — dominance, hierarchy, density, surface treatment, state-driven emphasis, and anti-patterns.
9. **Acceptance / executable contract** — measurable rules only after the relationship is stable enough to encode.

## Shared rules

- Current work outranks pattern chrome.
- A pattern may know Session, Workspace, Agent/location, attachment, and capability state; generic primitives should not.
- Do not collapse connectivity, Session lifecycle, and attachment into one status.
- Registered capability does **not** imply permanent navigation.
- Extensions contribute semantic capability; Nession chooses placement and interaction.
- Unavailable capabilities should normally leave no dead UI slot.
- Relevant/active capability can gain contextual presence; deeper UI is explicitly opened.
- Pattern-specific branding must not fragment Nession's global visual language.
- Shipping components are implementations and may be migration predecessors rather than product truth.

## How patterns compose conceptually

The composition is contextual rather than a fixed widget tree:

```text
Session navigation (on demand / compact)
        ↓
Active Session / current work
        ├── TerminalSurface
        │      └── TerminalCapsule
        │             └── contextual capability presence/actions
        │
        ├── Session / connectivity context when useful
        │
        └── Workspace contextual depth
               ├── resources / locations
               ├── relevant capabilities
               └── capability-specific deeper views
```

A current Web implementation may use SessionHeader + SurfaceSwitcher + WorkspaceNavigation. Those are valid patterns, but this diagram intentionally avoids declaring each of them permanently present.

App realizes the same semantics through its spatial `Sessions ← Terminal → Workspace` model and native deeper navigation.

## Capability example

For Claude Code:

```text
extension registered
    ≠ permanent Claude tab

installed / available
    -> may be discoverable in Workspace

relevant
    -> contextual Workspace/capsule affordance may appear

active in Session
    -> lightweight Session presence
    -> contextual actions
    -> explicit deeper state/history/configuration view
```

Codex, OpenCode, Git, Docker, Kubernetes, databases, and future capabilities should be able to reuse the same product mechanics.

## Contracts and visual baselines

Some existing executable contracts and fixtures were created before the root Vision/Principles and encode a more fixed Session-first shell. They remain valid for current shipping behavior until implementation is intentionally changed.

When a product decision changes a measurable pattern:

```text
canonical product docs
    ↓
pattern spec
    ↓
implementation
    ↓
executable contract
    ↓
canonical screenshot / regression baseline
```

Update the lower layers together. Do not use an old contract or screenshot as evidence that an upstream product decision cannot change.

## Anti-patterns

- Treating the catalog above as a list of controls that must always be visible.
- One extension = one permanent tab/button.
- Creating a new global shell pattern for every capability.
- Fixed tool enums that require shell changes for every extension.
- Duplicating product rules across many specs instead of linking to the canonical owner.
- Encoding exploratory product relationships as rigid executable contracts too early.

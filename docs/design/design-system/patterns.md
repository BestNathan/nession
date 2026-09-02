# Patterns

Nession-specific composition: assemblies of [primitives](components.md) that encode product IA and interaction. Product identity lives here, not in a custom button kit.

**Spec issue:** [#470](https://github.com/BestNathan/nession/issues/470)
**Architecture:** [product-model.md](../product-model.md), [information-architecture.md](../information-architecture.md), [workspace.md](../workspace.md)
**Tokens:** [tokens.md](tokens.md) — patterns consume Semantic / Domain / Experience only. Executable tokens: [#467](https://github.com/BestNathan/nession/issues/467).
**Visual language:** [visual-language.md](../visual-language.md) — dominance, emphasis, surface, and density rules ([#561](https://github.com/BestNathan/nession/issues/561) Phase 4).
**Contracts:** Measurable layout rules live in [contracts.md](contracts.md) / `design/contracts/` ([#545](https://github.com/BestNathan/nession/issues/545)); enforcement in [validation.md](validation.md) ([#546](https://github.com/BestNathan/nession/issues/546)–[#548](https://github.com/BestNathan/nession/issues/548)). Pattern prose keeps semantics; do not duplicate heights/wrap rules here.
**Implementation:** vertical slice [#471](https://github.com/BestNathan/nession/issues/471); Web [#472](https://github.com/BestNathan/nession/issues/472); App [#473](https://github.com/BestNathan/nession/issues/473). These specs do **not** implement React.

## Catalog

| Pattern | Spec | Role |
|---------|------|------|
| [SessionList](patterns/session-list.md) | container | Flat primary navigation |
| [SessionItem](patterns/session-item.md) | row | Workload hint, Agent identity, recency, selection, reachability |
| [SessionHeader](patterns/session-header.md) | chrome | Explicit connection context for the active Session |
| [AgentContext](patterns/agent-context.md) | chrome | Always available; quiet when healthy; prominent when not |
| [SurfaceSwitcher](patterns/surface-switcher.md) | Web chrome | Terminal \| Workspace peer-surface toggle |
| [WorkspaceNavigation](patterns/workspace-navigation.md) | tool chrome | Files \| Session \| Agent \| …; registry; no default inner sidebar |
| [ConnectionStatus](patterns/connection-status.md) | atom | Independent Agent / Session / attachment presentation |
| [FileWorkspace](patterns/file-workspace.md) | tool | Files master/detail; not the Workspace shell |
| [AgentDetail](patterns/agent-detail.md) | tool | Agent/connection details; single detail layout |
| [TerminalCapsule](patterns/terminal-capsule.md) | chrome | Floating Terminal input / commands composer (session-first) |
| [TerminalSurface](patterns/terminal-surface.md) | surface | xterm well, focus, scroll, clearance, attach lifecycle (session-first) |

App spatial navigation (`Sessions ← Terminal → Workspace`) is an [interaction model](../interaction/app.md), not a tenth pattern. Patterns that appear on App must respect that model and visible non-gesture alternatives ([#473](https://github.com/BestNathan/nession/issues/473)).

## Spec contract

Every pattern spec includes:

1. **Purpose** — what user job it serves; what it must not become.
2. **Anatomy** — named parts (ASCII is enough).
3. **States** — mapped to the three domain dimensions in [product-model.md](../product-model.md) where the pattern shows them. Unused dimensions are called out, not silently merged.
4. **Tokens** — Semantic / Domain / Experience names. No Primitive palette classes (`text-green-500`, `bg-zinc-900`, hex literals).
5. **Web vs App** — where chrome or density diverges. “Same on both” is an explicit statement.
6. **Visual Contract** — how this pattern maps to [visual-language.md](../visual-language.md): Dominance, Information hierarchy, Alignment, Density, Whitespace, Contrast, Surface treatment, State-driven emphasis, Anti-patterns, Canonical reference. Added in [#561](https://github.com/BestNathan/nession/issues/561) Phase 4 after canonical screens approve the rules.
7. **Acceptance** — visual/interaction checks for the vertical slice and later migration. Measurable layout rules (single-line, height token, overflow, touch target) belong in the linked UI contract once [#545](https://github.com/BestNathan/nession/issues/545) exists; Acceptance then indexes `Contract: pattern.<id>` instead of copying numbers.
8. **Contract** (when available) — one-line pointer to `design/contracts/patterns/<id>.json`.

## Shared rules

- Patterns may know Session, Agent, and attachment. [Primitives](components.md) may not.
- A pattern must not collapse Agent connection, Session lifecycle, and attachment into one status. Use [ConnectionStatus](patterns/connection-status.md) or compose its three channels.
- Adding a future Workspace tool registers with [WorkspaceNavigation](patterns/workspace-navigation.md). It does not require a new top-level pattern unless the tool introduces a new composition (Files does, via FileWorkspace).
- Shipping components (`web/src/components/SessionList.tsx`, `AgentCard.tsx`, `AgentDetailPanel.tsx`, `ModeBar.tsx`, `FileBrowser.tsx`) are **predecessors**, not these specs. Specs describe the Session-first target.

## How patterns compose (Web)

```text
┌─ SessionList ──────────────────────────────────┬─ Active Session ─────────────┐
│ SessionItem                                     │ SessionHeader                 │
│ SessionItem  ← selected                         │   AgentContext                │
│ SessionItem                                     │   ConnectionStatus            │
│                                                 │   SurfaceSwitcher             │
│                                                 │ ┌─ Active surface ──────────┐ │
│                                                 │ │ Terminal  XOR  Workspace  │ │
│                                                 │ │   WorkspaceNavigation     │ │
│                                                 │ │   FileWorkspace | …       │ │
│                                                 │ └───────────────────────────┘ │
└─────────────────────────────────────────────────┴───────────────────────────────┘
```

App uses the same SessionList / SessionItem / SessionHeader / AgentContext / ConnectionStatus / WorkspaceNavigation / FileWorkspace / AgentDetail semantics, with SessionList and Workspace as spatial layers instead of a persistent sidebar + SurfaceSwitcher. See each spec’s **Web vs App**.

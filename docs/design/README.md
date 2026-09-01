# Nession UI Architecture v2

Version-controlled product and UI architecture for the next Nession Web and App experience.

This index is the entry point. Downstream work — design tokens ([#467](https://github.com/BestNathan/nession/issues/467)), pattern specs ([#470](https://github.com/BestNathan/nession/issues/470)), executable UI contracts and validation ([#544](https://github.com/BestNathan/nession/issues/544)–[#548](https://github.com/BestNathan/nession/issues/548)), the vertical slice ([#471](https://github.com/BestNathan/nession/issues/471)), and platform migration ([#472](https://github.com/BestNathan/nession/issues/472), [#473](https://github.com/BestNathan/nession/issues/473)) — should reference these paths instead of a single GitHub issue.

**Umbrella:** [#468](https://github.com/BestNathan/nession/issues/468)
**This doc set:** [#469](https://github.com/BestNathan/nession/issues/469)

## Principle

> Session is the primary navigation object. Terminal is the primary work surface. Workspace augments the Session. Agent is persistent infrastructure context and the tmux proxy behind the Session.

Short form: **Session-first, Agent-aware, Terminal-first.**

## Layers

Keep these layers related but separate. Do not collapse IA into tokens, or interaction patterns into primitives.

```text
Product Model
      ↓
Information Architecture
      ↓
Interaction Model (Web / App)
      ↓
Design System (tokens + patterns)
      ↓
UI Contracts + Validation          ← #544–#548
      ↓
Implementation
```

## Documents

| Document | Responsibility |
|----------|----------------|
| [product-model.md](product-model.md) | Remote session workspace; Agent / Session / Terminal / Workspace; independent domain state dimensions |
| [information-architecture.md](information-architecture.md) | Session-first IA; flat Session list; Agent as progressive disclosure; no AI-chat IA concepts |
| [workspace.md](workspace.md) | Workspace as session-scoped tool container; initial tools; registry; Files master/detail is local to Files |
| [interaction/web.md](interaction/web.md) | Sessions sidebar + Active Session; Terminal \| Workspace as peer surfaces (one visible at a time) |
| [interaction/app.md](interaction/app.md) | Spatial model `Sessions ← Terminal → Workspace`; gestures as accelerators; not a shrunk Web layout |
| [design-system/tokens.md](design-system/tokens.md) | Token layers and Domain vocabulary aligned with this product model (executable tokens: [#467](https://github.com/BestNathan/nession/issues/467)) |
| [design-system/components.md](design-system/components.md) | Generic primitives (Button, Tabs, Sheet, …) |
| [design-system/patterns.md](design-system/patterns.md) | Pattern catalog + [nine specs](design-system/patterns.md#catalog) ([#470](https://github.com/BestNathan/nession/issues/470)) |
| [design-system/contracts.md](design-system/contracts.md) | Executable layout/pattern contracts; `design/contracts/` ownership ([#545](https://github.com/BestNathan/nession/issues/545), tracking [#544](https://github.com/BestNathan/nession/issues/544)) |
| [design-system/validation.md](design-system/validation.md) | Browser assertions, Web/App viewport matrix, focused visual regression ([#546](https://github.com/BestNathan/nession/issues/546)–[#548](https://github.com/BestNathan/nession/issues/548)) |
| [migration.md](migration.md) | Phases 2–4 child issues, validation slice, relationship to current UI |

## Related issues

| Phase | Issue | Scope |
|-------|-------|-------|
| 1 — Architecture docs | [#469](https://github.com/BestNathan/nession/issues/469) | This directory |
| 2 — Design tokens | [#467](https://github.com/BestNathan/nession/issues/467) | Executable token architecture + lint |
| 2 — UI patterns | [#470](https://github.com/BestNathan/nession/issues/470) | Pattern specifications |
| 2 — Executable UI constraints | [#544](https://github.com/BestNathan/nession/issues/544) | Contracts + assertions + viewport matrix + focused visual ([#545](https://github.com/BestNathan/nession/issues/545)–[#548](https://github.com/BestNathan/nession/issues/548)); architecture: [contracts.md](design-system/contracts.md), [validation.md](design-system/validation.md) |
| 3 — Vertical slice | [#471](https://github.com/BestNathan/nession/issues/471) | Session list → Terminal → Workspace validation path |
| 4 — Web migration | [#472](https://github.com/BestNathan/nession/issues/472) | Migrate full Web UI to session-first shell |
| 4 — App navigation | [#473](https://github.com/BestNathan/nession/issues/473) | App spatial model |

Related open issues that may overlap during migration: [#343](https://github.com/BestNathan/nession/issues/343), [#207](https://github.com/BestNathan/nession/issues/207), [#193](https://github.com/BestNathan/nession/issues/193), [#400](https://github.com/BestNathan/nession/issues/400).

## Predecessor

The 2026-08-08 [UI Design Protocol](../superpowers/specs/2026-08-08-ui-design-protocol.md) described the then-shipping Agent-first dashboard and Terminal+Files shell. **Product model, IA, and interaction in this directory supersede that protocol.** Visual-direction notes in the protocol remain useful until [#467](https://github.com/BestNathan/nession/issues/467) lands executable tokens; where they conflict, this architecture and #467 win.

## Maintenance

One requirement = one issue. When [#468](https://github.com/BestNathan/nession/issues/468) changes, update these files in place via PRs that reference [#469](https://github.com/BestNathan/nession/issues/469). Do not fork a second architecture tree.

# Migration

This architecture is documentation only until later phases implement it. [#469](https://github.com/BestNathan/nession/issues/469) is satisfied when this `docs/design/` tree is on the default branch.

## Phases

| Phase | Issue | What lands |
|-------|-------|------------|
| 1 — Architecture docs | [#469](https://github.com/BestNathan/nession/issues/469) | This directory |
| 2 — Design tokens | [#467](https://github.com/BestNathan/nession/issues/467) | Executable Primitive / Semantic / Domain / Experience tokens + lint |
| 2 — UI patterns | [#470](https://github.com/BestNathan/nession/issues/470) | [Pattern specs](design-system/patterns.md) |
| 2 — Executable UI constraints | [#544](https://github.com/BestNathan/nession/issues/544) | [Contracts](design-system/contracts.md) + [validation](design-system/validation.md) (#545–#548). Docs may land before code; resolving token values requires #467 on `main` |
| 3 — Vertical slice | [#471](https://github.com/BestNathan/nession/issues/471) | One complete Session-first path before broad migration |
| 4 — Web | [#472](https://github.com/BestNathan/nession/issues/472) | Remaining Web flows into the new IA; remove obsolete Agent-first navigation |
| 4 — App | [#473](https://github.com/BestNathan/nession/issues/473) | Spatial `Sessions ← Terminal → Workspace` without copying Web layout |

Add future Workspace tools only after the core architecture is stable (after the slice, not as a prerequisite for it).

## Validation slice

Before migrating the whole application, implement one complete vertical slice ([#471](https://github.com/BestNathan/nession/issues/471)):

```text
Session List
    ↓
Select Session
    ↓
Terminal
    ↓
Switch to Workspace
    ↓
Files
    ↓
Open file in Editor
    ↓
Workspace → Agent Detail
    ↓
Return to Terminal
```

The slice must validate both the IA and the new design system (tokens from #467, patterns from #470), including independent Agent / Session / attachment presentation. As [#544](https://github.com/BestNathan/nession/issues/544) lands, the same slice should also exercise executable [contracts](design-system/contracts.md) and [validation](design-system/validation.md) on the critical Session / Terminal / Workspace surfaces.

## From the current UI

The shipping shell (see [UI Design Protocol](../superpowers/specs/2026-08-08-ui-design-protocol.md)) is Agent/dashboard-first and often keeps Terminal adjacent to Files. v2 changes that:

| Current (shipping) | v2 |
|--------------------|----|
| Dashboard of Agents, then sessions | Flat Session list as primary nav |
| Agent as navigation parent | Agent as metadata + Workspace tool |
| Terminal and Files as concurrent chrome | Terminal \| Workspace peer surfaces, one visible |
| Files ≈ the secondary panel | Files is one Workspace tool |
| Mobile ModeBar / panel pager as shrunk Web | App spatial model, not a breakpoint copy |

Related work that may overlap during migration: [#343](https://github.com/BestNathan/nession/issues/343), [#207](https://github.com/BestNathan/nession/issues/207), [#193](https://github.com/BestNathan/nession/issues/193), [#400](https://github.com/BestNathan/nession/issues/400). Coordinate; do not silently redefine those issues' scope.

## Non-goals of this architecture (reminder)

- Turning Nession into an AI chat client, or parsing CLI output into a conversation model.
- Making Agent invisible.
- Grouping all Sessions under Agent navigation.
- Permanently displaying Terminal and Workspace side-by-side on Web.
- Making the App a responsive copy of the Web UI.
- Designing every future Workspace tool before the core IA is validated.

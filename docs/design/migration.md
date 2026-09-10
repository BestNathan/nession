# Design Migration

> Status: **migration / historical context**. This document does not define product direction.
>
> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [design index](README.md)

This file records the major UI architecture migrations that produced the current Session-first implementation and the next convergence work required after establishing the repository Vision and Principles.

Historical issues remain useful implementation context, but no earlier issue, screenshot, or migration phase outranks `VISION.md` or `PRINCIPLE.md`.

## Completed Session-first migration

The earlier UI architecture program moved Nession away from an Agent-first dashboard toward a Session-first shell.

| Phase | Issue | Outcome |
|-------|-------|---------|
| Architecture docs | [#469](https://github.com/BestNathan/nession/issues/469) | Initial v2 product/IA documentation |
| Design tokens | [#467](https://github.com/BestNathan/nession/issues/467) | Executable Semantic / Domain / Experience token architecture |
| UI patterns | [#470](https://github.com/BestNathan/nession/issues/470) | Product pattern specifications |
| Executable UI constraints | [#544](https://github.com/BestNathan/nession/issues/544)–[#548](https://github.com/BestNathan/nession/issues/548) | Contracts, validation, and visual baselines |
| Vertical slice | [#471](https://github.com/BestNathan/nession/issues/471) | Session → Terminal → Workspace path |
| Web migration | [#472](https://github.com/BestNathan/nession/issues/472) | Session-first Web shell |
| App navigation | [#473](https://github.com/BestNathan/nession/issues/473) | Spatial `Sessions ← Terminal → Workspace` model |
| Visual convergence | [#561](https://github.com/BestNathan/nession/issues/561) | Visual language, composition, canonical fixtures |

As of 2026-09-08, the Session-first shell is the shipping implementation. The old Agent-first Dashboard is therefore historical implementation context, not the target architecture.

## What changed with the product-contract convergence

Issue [#699](https://github.com/BestNathan/nession/issues/699) introduces a higher-level hierarchy:

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
feature design
    ↓
implementation
```

This does **not** discard the Session-first work. It clarifies which parts are durable product decisions and which parts were implementation choices made during that migration.

Durable/current decisions include:

- users return to current work through Sessions rather than navigating infrastructure first;
- Terminal is the dominant live surface for the current Session implementation;
- Agent/connectivity is infrastructure context, not the primary work hierarchy;
- App keeps a spatial `Sessions ← Terminal → Workspace` relationship;
- visual chrome should remain quiet and precise.

Concepts being broadened or corrected include:

- Workspace is a logical work context that may span locations, not only a container of Session-scoped tools;
- a registered extension is not entitled to permanent Workspace navigation;
- capabilities can be available, relevant, or active and should gain UI presence contextually;
- TerminalCapsule evolves from a terminal quick-input toolbar into a conversational/contextual interaction surface;
- Claude Code / Codex structured state may be surfaced by extensions without making an AI-chat model universal to every Session;
- persistent SurfaceSwitcher / Workspace tool bars are implementation options, not product invariants.

## Current convergence path

The implementation direction is intentionally tracked in [#699](https://github.com/BestNathan/nession/issues/699) and follow-up issues rather than frozen in a third root design document.

At a high level:

```text
Session-first work surface
    ↓
contextual interaction capsule
    ↓
runtime / environment capability awareness
    ↓
context-driven capability presence
    ↓
Workspace as contextual depth
    ↓
logical Workspace spanning multiple locations/nodes
```

Claude Code is the first reference integration used to validate that capability model. It is not a special product branch.

## Executable-contract migration debt

Existing UI contracts, fixtures, and visual baselines encode some assumptions from the previous Session-first implementation. Examples include permanent SurfaceSwitcher placement, Workspace navigation shape, and the older TerminalCapsule semantics.

The documentation convergence in #699 should **not** silently rewrite those executable constraints without the corresponding implementation change.

Instead, follow this sequence:

1. establish the product relationship in canonical docs;
2. identify contracts/screens/components that contradict it;
3. create focused implementation changes;
4. update contracts and baselines in the same change as behavior;
5. validate that the new behavior remains consistent across Web/App.

A canonical screenshot protects an approved implementation from accidental drift. It does not freeze a product decision after that decision has intentionally changed.

## Historical validation slice

The original migration slice was:

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

This remains useful regression coverage for existing behavior, but future validation should add the contextual capability path, for example:

```text
Attach Session
    ↓
Terminal remains primary
    ↓
Capability becomes relevant / active
    ↓
lightweight Session presence appears
    ↓
user explicitly opens contextual actions / deeper view
    ↓
Workspace exposes broader capability context
    ↓
return to the same Session without losing continuity
```

## Migration rules going forward

- Do not preserve old navigation simply because it already ships.
- Do not remove reliable implementation behavior without a replacement path.
- Separate capability contribution from where Nession chooses to present it.
- Update design docs when a feature changes the meaning of a canonical concept.
- Update implementation + executable contract + visual baseline together when a measurable UI contract changes.
- Keep historical rationale where it is still useful, but label it as historical rather than a competing source of truth.

## Non-goals

- Making every Session an AI conversation.
- Hiding infrastructure when infrastructure state actually affects the work.
- Rebuilding all design-system primitives merely because the product model evolved.
- Rewriting stable token values that remain semantically correct.
- Treating #699 as a mandate for a single large-bang UI rewrite.

The desired migration is incremental: preserve reliability while moving visible product complexity toward contextual, progressively disclosed capability.

# Nession Product & UI Design

This directory translates Nession's repository-level product contract into concrete product models, information architecture, interactions, visual language, and executable UI constraints.

The two upstream sources of truth live at the repository root:

1. [`../../VISION.md`](../../VISION.md) — product direction: the problem Nession solves and where the product is going.
2. [`../../PRINCIPLE.md`](../../PRINCIPLE.md) — durable product design decision rules.

Everything in `docs/design/` is downstream from those two files. Existing design documents and shipping code must converge toward them when a conflict is found.

## Precedence

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
Product Model
    ↓
Information Architecture
    ↓
Interaction Model (Web / App)
    ↓
Workspace / Capability Semantics
    ↓
Visual Language
    ↓
Layout / Composition
    ↓
Design System (tokens + patterns + contracts)
    ↓
Feature Design
    ↓
Implementation
```

This hierarchy is intentional. Lower-level implementation detail must not silently redefine product direction.

## Current product direction

The current implementation is **Session-first and Terminal-first**, but those are implementation/product-model choices under the broader Vision, not the Vision itself.

The key downstream interpretation of the Principles is:

- the current work dominates the interface;
- chrome and infrastructure context recede;
- capabilities earn presence from context instead of occupying permanent navigation;
- deeper state and configuration are progressively disclosed;
- extensions contribute capability while Nession owns placement, interaction, and visual language;
- Workspace is contextual depth around the work, not a feature lobby;
- local and remote execution contexts should converge into one continuous workspace model.

## Canonical documents

| Document | Status | Responsibility |
|----------|--------|----------------|
| [product-model.md](product-model.md) | Canonical | Product concepts and relationships: Workspace, Workspace Location, Session, Terminal, Agent, contextual capabilities |
| [information-architecture.md](information-architecture.md) | Canonical | Session-first IA, progressive disclosure, contextual capability presence, Workspace depth |
| [workspace.md](workspace.md) | Canonical | Logical Workspace semantics, locations, capability contribution and visibility rules |
| [interaction/web.md](interaction/web.md) | Canonical | Web realization of the product model |
| [interaction/app.md](interaction/app.md) | Canonical | App spatial model, gestures, capsule, contextual capability surfaces |
| [visual-language.md](visual-language.md) | Canonical | What dominates and recedes; typography, surfaces, density, emphasis |
| [composition.md](composition.md) | Canonical / evolving | Page-level layout relationships and responsive composition; must stay subordinate to contextual-presence rules |
| [design-system/tokens.md](design-system/tokens.md) | Canonical implementation contract | Token layers and semantic vocabulary; never decides product presence |
| [design-system/components.md](design-system/components.md) | Canonical implementation contract | Generic primitives and product/pattern boundary |
| [design-system/patterns.md](design-system/patterns.md) | Canonical implementation contract | Reusable product/UI patterns and contextual capability composition |
| [design-system/contracts.md](design-system/contracts.md) | Canonical executable-contract architecture | Measurable consequences of approved pattern decisions; downstream from product semantics |
| [design-system/validation.md](design-system/validation.md) | Canonical validation | Context/viewport assertions and focused visual regression for current approved contracts |
| [migration.md](migration.md) | Migration | Transitional implementation plan; never overrides the canonical product model |
| [styling-convergence.md](styling-convergence.md) | Historical migration record | Completed styling/token convergence rationale and ownership lessons; not current product structure |

## Reading order for product-facing work

For any change involving Session, Workspace, navigation, UI, interactions, extensions, capabilities, or other user-facing behavior:

```text
VISION.md
  -> PRINCIPLE.md
  -> this index
  -> product-model.md
  -> information-architecture.md
  -> relevant interaction/workspace/visual docs
  -> design-system patterns/contracts
  -> implementation
```

Do not begin from the shipping component tree and infer the intended product from it. Current code may represent a migration state.

## Capability design rule

A capability is not entitled to permanent UI simply because it exists.

The generic lifecycle used by downstream design is:

```text
unavailable -> available -> relevant -> active
```

The exact detection mechanism is an implementation concern. Product presence follows context:

- unavailable capabilities stay hidden;
- available capabilities may be discoverable where they are useful, especially in Workspace;
- relevant capabilities gain contextual prominence;
- active capabilities may surface in the current Session and interaction capsule;
- deeper views and configuration are explicitly opened rather than permanently occupying the work surface.

Claude Code is the first reference integration for validating this model, not a special-case product direction.

## Multi-location design rule

Workspace is logical context, while Agent/provider/directory/environment are physical realization details through Workspace Locations.

Lower-level patterns should therefore avoid assumptions such as:

- one Workspace equals one Agent;
- Files always means the active Session's remote directory;
- Agent must be permanently visible as a navigation parent;
- one Location failure invalidates the whole Workspace;
- Session/attachment/infrastructure status can be represented by one fused state.

Current Agent/tmux-backed implementation remains valid, but design vocabulary should leave room for additional Locations/providers without changing the user's core mental model.

## Design review check

Before accepting a product-facing design, verify:

- Does it move Nession toward [`VISION.md`](../../VISION.md)?
- Does it obey [`PRINCIPLE.md`](../../PRINCIPLE.md)?
- Is the current work still the visual and interaction focus?
- Is every persistent control justified by what matters now?
- Can contextual capability replace permanent navigation?
- Is deeper complexity progressively disclosed?
- Does an extension integrate into Nession's product language instead of creating a parallel one?
- Does the design preserve logical Workspace semantics instead of leaking unnecessary infrastructure topology?
- Are executable contracts/screenshots treated as downstream enforcement rather than upstream product truth?
- Are existing downstream documents updated when their meaning changes?

## Existing implementation and migration references

This design tree originated from the Session-first UI architecture work tracked in [#468](https://github.com/BestNathan/nession/issues/468), [#469](https://github.com/BestNathan/nession/issues/469), [#561](https://github.com/BestNathan/nession/issues/561), and the executable design-system work in [#544](https://github.com/BestNathan/nession/issues/544)–[#548](https://github.com/BestNathan/nession/issues/548).

Those issues remain useful implementation history, but they are not upstream of `VISION.md` or `PRINCIPLE.md`.

The 2026-08-08 [UI Design Protocol](../superpowers/specs/2026-08-08-ui-design-protocol.md) is a predecessor. Where historical assumptions conflict with the current hierarchy, the current hierarchy wins.

## Maintenance

Keep one canonical owner for each concept. Prefer links over copying the same rule into multiple documents. When Vision or Principles change, explicitly audit this directory rather than allowing parallel sources of truth to drift.

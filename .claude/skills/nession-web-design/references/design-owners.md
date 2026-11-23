# Nession Design Owner Map

This is a **navigation map**, not a second design system. Read the row the routing decision selects; do not restate or re-derive the linked owner's rules here.

## Upstream product contract

| Owner | Purpose |
|---|---|
| [VISION.md](../../../../VISION.md) | Enduring product direction and the problem Nession solves |
| [PRINCIPLE.md](../../../../PRINCIPLE.md) | Durable product design decision constraints |
| [PRODUCT.md](../../../../PRODUCT.md) | Per-generation positioning and applicable experience target |

Lower-level code, fixtures, screenshots, and historical documents do not override these.

## Product and design doctrine

| Owner | Purpose |
|---|---|
| [docs/design/README.md](../../../../docs/design/README.md) | Precedence chain and canonical-document index |
| [product-model.md](../../../../docs/design/product-model.md) | Project, Workspace, Location, Session, Terminal, Agent, contextual capabilities |
| [project.md](../../../../docs/design/project.md) | Project declaration and Workspace/Location/Session ownership |
| [information-architecture.md](../../../../docs/design/information-architecture.md) | Session-first IA, progressive disclosure, contextual capability presence |
| [workspace.md](../../../../docs/design/workspace.md) | Logical Workspace semantics and capability contribution/visibility |
| [capability-emergence.md](../../../../docs/design/capability-emergence.md) | Progressive capability disclosure and Peek/Workspace depth |
| [interaction/web.md](../../../../docs/design/interaction/web.md) | Web realization of the product model |
| [interaction/app.md](../../../../docs/design/interaction/app.md) | App spatial model, gestures, capsule, contextual surfaces |
| [visual-language.md](../../../../docs/design/visual-language.md) | What dominates/recedes; typography, surfaces, density, emphasis |
| [composition.md](../../../../docs/design/composition.md) | Page-level layout relationships, responsive composition, layout ownership |
| [terminal/README.md](../../../../docs/design/terminal/README.md) | Terminal platform and renderer-facing design context |

## Design-system contracts

| Owner | Purpose |
|---|---|
| [design-system/tokens.md](../../../../docs/design/design-system/tokens.md) | Token layers and semantic vocabulary |
| [design-system/spatial-relationships.md](../../../../docs/design/design-system/spatial-relationships.md) | Shared spacing meaning, content rhythm, geometry ownership |
| [design-system/components.md](../../../../docs/design/design-system/components.md) | Generic primitives and product/pattern boundary |
| [design-system/patterns.md](../../../../docs/design/design-system/patterns.md) | Reusable product/UI patterns and contextual composition |
| [design-system/contracts.md](../../../../docs/design/design-system/contracts.md) | Executable-contract architecture |
| [design-system/validation.md](../../../../docs/design/design-system/validation.md) | Context/viewport assertions, browser proof, capability visual recipes |
| [design-system/inventory.md](../../../../docs/design/design-system/inventory.md) | Coverage audit and evidence; never overrides canonical owners |

## Executable and source owners

| Owner | Purpose |
|---|---|
| [design/AGENTS.md](../../../../design/AGENTS.md) | `design/` scope: token/contract/generated ownership and validation |
| [web/AGENTS.md](../../../../web/AGENTS.md) | Web layering, state, transport, and testing boundaries |
| [docs/architecture/web.md](../../../../docs/architecture/web.md) | Complete Web layer/import model |
| `design/tokens/` | Canonical token values |
| `design/contracts/` | Canonical UI contracts |
| `design/generated/` | Generated projections; never hand-edited |
| `design/scripts/design-gate.mjs` | Canonical design checker (profiles, live rule list) |
| `design/scripts/layout-ownership.mjs` | Layout-ownership rule used by `design-system-fast` |
| `design/scripts/browser-design-catalog.mjs` | Mandatory browser-profile subset and `CAPABILITY_VISUAL_INVARIANTS` |
| `design/scripts/verify-browser-design-report.mjs` | Independent browser-design verdict from executed evidence |
| `design/scripts/audit-design-system.mjs` | Executable component/token inventory |

## Related workflows

| Skill | Ownership |
|---|---|
| [nession-development](../../nession-development/SKILL.md) | Issue-first, worktree, implementation, verification, PR, CI |
| [nession-prototype](../../nession-prototype/SKILL.md) | Clickable mock flow, shared orphan `prototype` branch, Issue backlinks |
| [nession-writing-requirements](../../nession-writing-requirements/SKILL.md) | Requirement/Bug authoring and prototype necessity |
| [nession-gates](../../nession-gates/SKILL.md) | Gate design, routing, failure repair |
| [nession-knowledge](../../nession-knowledge/SKILL.md) | Durable project knowledge retrieval and publication |

## Integrity rule

If a canonical document moves, update the link at its owner map or Skill surface rather than copying the content into the router. When a linked owner and this map disagree, the linked owner wins and the map is stale.

The maintained shadcn inventory reference is [nession-development/references/shadcn-components.md](../../nession-development/references/shadcn-components.md); executable counts come from `just design-inventory` / `just design-inventory-json`.

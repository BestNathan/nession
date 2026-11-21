# shadcn/ui Component Decisions

shadcn/ui is Nession's **implementation source for generic primitives**. It is not the design system owner: product semantics, patterns, tokens, geometry, and validation belong to the Nession owners listed in [design-owners.md](design-owners.md).

This reference owns component selection mechanics only.

## Precedence

Use the first available level:

1. **existing Nession pattern/component** — product/pattern owners under `web/src/product/*/patterns` or the owning capability;
2. **installed shadcn/ui primitive** — `web/src/components/ui/`;
3. **add an official shadcn/ui primitive** through the normal CLI/source workflow;
4. **small generic wrapper** — only when Nession needs stable shared behavior across consumers;
5. **feature-local UI** — only when the need is truly feature-specific.

Do not add a primitive preemptively. Do not use a generic primitive to bypass a product pattern or a layout recipe.

## Live inventory

The inventory is executable; do not maintain a copied component table here.

```bash
just design-inventory
just design-inventory-json
```

Authoritative sources:

- `design/scripts/audit-design-system.mjs` — executable inventory and consumer evidence;
- [nession-development/references/shadcn-components.md](../../nession-development/references/shadcn-components.md) — human navigation reference and installation rules;
- [docs/design/design-system/components.md](../../../../docs/design/design-system/components.md) — primitive/pattern ownership boundary;
- [docs/design/design-system/inventory.md](../../../../docs/design/design-system/inventory.md) — audit conclusions and coverage model;
- `web/src/components/ui/` — current installed source.

Check the live tree before deciding that a primitive is missing. A stale list or memory is not evidence.

## Selection procedure

1. Name the need semantically: reusable value, generic interaction, named product pattern, feature-local composition, or renderer boundary.
2. Search existing Nession patterns/components for the same semantics.
3. If a generic primitive is genuinely needed, check the installed tree and `just design-inventory-json`.
4. If absent, check the official shadcn/ui source for the primitive and confirm it fits the generic boundary.
5. Install through the CLI, then normalize.
6. Re-run the relevant design/Web Gates and browser proof when rendered behavior changes.

## Installation

Nession's documented CLI route:

```sh
cd web && npx shadcn@latest add <name> --yes
```

Review the generated diff. Installation is only the import step; generated code is not automatically integrated Nession UI.

### Normalization

After adding a primitive:

- map raw values to Nession Semantic/Experience vocabulary and generated tokens;
- keep the primitive API generic — no Session, Workspace, Agent, Terminal, capability, or presence policy in `components/ui`;
- follow the ownership boundary in `docs/design/design-system/components.md`;
- keep destructive confirmation on the approved primitive (see the maintained inventory reference rather than restating the rule);
- verify focus, disabled, and state treatment through the design Gate/browser proof where affected.

## Wrapper boundary

A wrapper in `components/ui` may adapt a primitive for stable generic behavior (for example, normalizing geometry across consumers). It must not become:

- a product-pattern owner;
- a place for capability-presence policy;
- a substitute for a semantic layout recipe;
- a dumping ground for feature-specific variants.

If the wrapper needs product semantics, move that behavior upward to the pattern/feature owner.

## Negative checks

Reject these decisions:

- adding a primitive "for later" without a consumer;
- copying a primitive list or consumer count into a Skill/reference instead of querying the live inventory;
- replacing an approved product pattern with a generic primitive;
- editing generated token artifacts to make a generated primitive look consistent;
- putting feature semantics in `components/ui`;
- weakening a design Gate because generated code violates a contract.

## Cross-references

- [SKILL.md](../SKILL.md) — routing entrypoint
- [routing.md](routing.md) — when a component decision is part of the task
- [design-owners.md](design-owners.md) — canonical ownership map
- [nession-development/references/shadcn-components.md](../../nession-development/references/shadcn-components.md) — current inventory reference and rules

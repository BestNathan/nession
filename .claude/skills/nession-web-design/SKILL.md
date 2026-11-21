---
name: nession-web-design
description: Use for Nession Web/App UI work as the task-aware router for canonical design owners, optional Impeccable capabilities, shadcn/ui component selection, and Nession Gates with Chromium/Playwright proof.
---

# Nession Web Design Router

This is the single entrypoint for UI/design work. It routes each task to the smallest useful combination of:

- canonical Nession design owners;
- optional Impeccable design/analysis capabilities;
- shadcn/ui implementation sources;
- Nession-owned Gates and Chromium/Playwright proof.

It routes; it does not own canonical design truth. Authority stays with `VISION.md`, `PRINCIPLE.md`, `docs/design/*`, `design/AGENTS.md`, and `web/AGENTS.md`. External advice never overrides those owners. Issue, worktree, PR, and CI flow belongs to [nession-development](../nession-development/SKILL.md).

## 1. Route before styling

1. Classify the task with [references/routing.md](references/routing.md).
2. Read only the canonical owners that classification names; navigate them with [references/design-owners.md](references/design-owners.md).
3. If the task includes a component decision, follow [references/shadcn.md](references/shadcn.md).
4. Decide optional Impeccable use with [references/impeccable.md](references/impeccable.md). Select it only when the task needs design direction, critique, or edge-case analysis beyond what Nession owners already specify; a settled implementation-only edit does not need it.
5. Validate with Nession Gates and Chromium/Playwright (section 7).
6. Record the concise capability choice (section 11).

Never install, upgrade, or overwrite external tooling silently. Missing optional tooling does not block the Nession workflow; record the state and continue with canonical owners.

### Host discovery

Claude Code discovers Skill content under `.claude/skills/`; Codex consumes the same physical tree through the repository's `.agents/skills` symlink. A command or skill is available only when the current host has actually discovered it. A file on disk is documentation, not a registered command; record `docs-only` in that case and never claim execution.

## 2. Authority and conflict rule

Precedence for this Skill:

```text
VISION.md
  -> PRINCIPLE.md
  -> PRODUCT.md / applicable generation
  -> docs/design/* (product model, IA, interaction, visual language, composition)
  -> Experience host geometry / semantic layout recipes / capability-local content
  -> implementation
```

If an Impeccable or other external recommendation conflicts with a Nession owner, the Nession owner wins. State the rejected recommendation when it would otherwise affect the design decision. Never change a canonical contract merely because current implementation or external advice disagrees.

## 3. Progressive design lookup

For product-facing work read `VISION.md`, `PRINCIPLE.md`, and the relevant `docs/design/*` document. A common lookup set is:

- `docs/design/product-model.md`
- `docs/design/information-architecture.md`
- `docs/design/interaction/web.md` or `docs/design/interaction/app.md`
- `docs/design/visual-language.md`
- `docs/design/composition.md`
- the specific design-system or pattern document for the surface.

[references/design-owners.md](references/design-owners.md) is the complete navigation map. This Skill does not mirror those documents.

## 4. Token decisions

Before adding a value:

1. Is there already a semantic token?
2. Is the need actually layout/flow rather than a design token?
3. Is it renderer-owned and therefore needs an adapter?
4. If a new token is needed, which semantic role owns it?

Change canonical sources and regenerate outputs; never hand-edit generated token artifacts. Canonical token ownership is `design/tokens/` and `docs/design/design-system/tokens.md`.

## 5. Component decisions

Prefer in order:

1. existing Nession pattern/component;
2. installed shadcn/ui primitive;
3. add an official shadcn/ui primitive through its normal CLI/source workflow;
4. a small generic wrapper if Nession needs stable shared behavior;
5. feature-local UI only when it is truly feature-specific.

The live inventory is executable, not a list in this Skill:

```bash
just design-inventory
just design-inventory-json
```

Follow [references/shadcn.md](references/shadcn.md) for selection, installation, normalization, and wrapper boundaries. The maintained inventory reference is `nession-development/references/shadcn-components.md`.

## 6. Layout and product patterns

Keep global product structure owned by Nession. Extensions/capabilities may contribute state/actions/views but must not independently redefine navigation or visual language. Apply progressive disclosure: presence/state first, deeper controls when relevant. Do not solve missing ownership with arbitrary Tailwind literals.

### Layout ownership (#3194)

Layout has three owners, not one universal DSL:

1. the **Experience host** owns page geometry, navigation frame, scroll ancestry, safe areas, and the one App header/Back;
2. a **semantic layout recipe** owns a stable relationship repeated by independent consumers (`WorkspaceMasterDetail`, `WorkspaceScrollRegion`; existing `ResourceDetail` / `ConfigurationForm` / `OperationSurface`);
3. **capability-local composition** owns only its content inside that host.

Local `flex`, `grid`, `min-w-0`, `min-h-0`, `flex-1`, and `cn()` conditionals remain legal. Do not take host geometry (`h-screen`, `min-h-[100dvh]`, `fixed inset-0`), render an App page header/Back, publish Workspace shell/tool chrome, or restate a shared recipe's stable class. `design/scripts/layout-ownership.mjs` runs in `design-system-fast`; the full inventory and repair path are in [composition.md §14](../../../docs/design/composition.md#14-layout-ownership-and-shared-recipes-3194).

## 7. Validation is Nession-owned

During iteration:

```bash
./gates/run design-system-fast
```

Before handoff, run the appropriate full design/Web checks for the change:

```bash
./gates/run design-system-full web-eslint web-typecheck web-test-unit
```

Do not copy the live design-rule list from `design/scripts/design-gate.mjs`. A failing Gate is repaired at its reported owner; never bypass it.

### Browser proof

**All Web/App interaction and visual acceptance is Chromium + Playwright only**, using the canonical E2E browser runner and viewport matrix. This includes App/mobile gestures: emulate viewport, touch/pointer, landscape, focus, scroll, keyboard/IME-related app state, and accessibility; use snapshots and deterministic assertions when visual output matters. Physical mobile devices, Mobile Safari, and installed iOS Apps are not acceptance prerequisites or alternative SC proof methods. If an OS-only behavior cannot be emulated, specify a Nession-owned observable contract and note the simulator limit instead of introducing a real-device Pending gate; do not claim to have tested native Safari behavior.

UI/interaction changes require real Chromium browser inspection at the actual affected flow, verifying intended state/action, the relevant responsive/app/web surface, no obvious regression in adjacent states, and before/after visual evidence when the change is visual. Repository browser/E2E policy is owned by `design/scripts/browser-design-catalog.mjs` and [docs/design/design-system/validation.md](../../../docs/design/design-system/validation.md); do not update a baseline merely to hide a structured contract failure.

A new capability surface that composes details, configuration, or an operation must reuse the approved recipe and its executable roles:

1. select `ResourceDetail` / `ConfigurationForm` / `OperationSurface` instead of assembling a local hierarchy;
2. identify the visual relation — a `parts` typography role or a `controlHeightToken` band — and its owner in `design/scripts/browser-design-catalog.mjs` (`CAPABILITY_VISUAL_INVARIANTS`);
3. exercise a deterministic production fixture state and compare corresponding parts relationally; Web/App role values may legitimately differ;
4. run `./gates/run design-system-fast`, then the canonical Browser Design profile / Full E2E, and inspect the relevant screenshot diff.

The checklist and non-goals are owned by [validation.md §Capability visual recipes](../../../docs/design/design-system/validation.md#capability-visual-recipes-3138).

### Optional Impeccable diagnostics

Impeccable `detect` and review playbooks are optional complementary diagnostics. They never substitute for the Gates above, browser proof, or Acceptance evidence, and this Skill does not add or change CI enforcement. Record any advisory findings separately; adopting a detect rule/threshold as a repository rule requires its own measured follow-up and explicit owner.

## 8. Third-party renderers

For xterm, CodeMirror, markdown renderers, or other internally styled systems, utility classes on the outer component may not control the rendered result. Put design translation at the renderer's owned adapter/theme boundary and verify computed/rendered behavior.

## 9. Prototype consistency

For a clickable exploration of unresolved interaction/product behavior use [nession-prototype](../nession-prototype/SKILL.md); [nession-writing-requirements](../nession-writing-requirements/SKILL.md) owns whether/when an Issue needs a prototype. A mock is not production UI, a Gate run, or a trusted browser/Acceptance receipt.

When a layout or interaction decision changes, check the owning Issue for a linked prototype. If its visible behavior would contradict the new design, revise the **same** prototype and its Issue/gallery links before reporting design completion. A formerly approved screenshot or prototype SHA does not remain valid after a superseding decision; if synchronization is blocked, visibly mark the artifact stale instead of citing it as current.

## 10. Failure repair

When a design Gate fails, follow its reported owner/repair. Never fix by:

- `eslint-disable`;
- lowering a visual/design threshold;
- adding feature-local magic values around a missing token;
- editing generated artifacts;
- changing a canonical contract only because current implementation violates it;
- substituting optional tool output for a failed Nession Gate.

If intended product behavior genuinely changed, update the canonical design owner and its proof together.

## 11. Completion and audit record

A UI change is complete when:

- product intent aligns with Vision/Principles;
- the correct owner was used;
- relevant design/Web Gates pass;
- the real browser flow was inspected;
- canonical docs/contracts changed when the design decision changed.

Leave a concise, auditable choice. One line is normally enough:

```text
Design route: owners=[...]; shadcn=[selected/skip: reason]; impeccable=[active: command | docs-only | skipped: reason | unavailable: reason]; validation=[gates + browser flow]; docs-only=[paths | none]
```

Record a skipped optional capability only when it is material, and an unavailable tool whenever the task expected it. Do not add per-task ceremony for a routine, fully owner-specified edit.

## References

| Reference | Use when |
|---|---|
| [references/routing.md](references/routing.md) | Classifying a UI task, selecting/skipping capabilities, checking routing examples and their deterministic assertions |
| [references/impeccable.md](references/impeccable.md) | Discovering, installing, verifying, using, or falling back from Impeccable; validating execution claims |
| [references/shadcn.md](references/shadcn.md) | Choosing, adding, or normalizing a shadcn/ui primitive; wrapper boundaries |
| [references/design-owners.md](references/design-owners.md) | Navigating canonical Nession product/design owners and executable validators |

Keep implementation-specific inventories out of this Skill; link to their owners instead.

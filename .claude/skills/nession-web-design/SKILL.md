---
name: nession-web-design
description: Use for Nession Web UI work involving visual styling, layout, interaction, responsive behavior, design tokens/contracts, shadcn primitives, product patterns, or browser/visual validation.
---

# Nession Web Design

This Skill owns the **UI/design decision and validation workflow**. Web engineering layering belongs to `web/AGENTS.md`; canonical design sources belong to `design/AGENTS.md` and `docs/design/`.

## 1. Read upstream product constraints

For product-facing work read:

- `VISION.md`
- `PRINCIPLE.md`
- relevant `docs/design/*`
- `web/AGENTS.md`
- `design/AGENTS.md`

Do not infer product design from one existing component if canonical product/design guidance says otherwise.

For a **clickable exploration of unresolved interaction/product behavior**, use [nession-prototype](../nession-prototype/SKILL.md) for mock construction, the shared orphan `prototype` branch and Issue backlinks. [nession-writing-requirements](../nession-writing-requirements/SKILL.md) owns **whether/when** the Issue needs a prototype. A mock artifact is not the production UI, a design Gate run or a trusted browser/Acceptance receipt.

### Linked prototype consistency on UI decisions

When a layout or interaction decision changes, check the owning Issue for a linked prototype. If its visible behavior would contradict the new design, follow `nession-writing-requirements` + `nession-prototype` to revise the **same** prototype and its Issue/gallery links before reporting design completion. A formerly approved screenshot or prototype SHA does not remain valid after a superseding decision; if synchronization is blocked, visibly mark the artifact stale instead of citing it as current.

## 2. Find the owner before styling

Classify the need:

- reusable semantic value -> design token;
- reusable generic interaction primitive -> `components/ui` / shadcn;
- named Nession product pattern -> canonical pattern owner;
- feature-local composition -> owning product/capability/app component;
- third-party renderer boundary -> adapter/theme at that renderer.

Do not solve missing ownership with arbitrary Tailwind literals.

## 3. Progressive design lookup

Read only the relevant design sources, typically:

- `docs/design/product-model.md`
- `docs/design/information-architecture.md`
- `docs/design/visual-language.md`
- `docs/design/design-system/tokens.md`
- `docs/design/design-system/components.md`
- `docs/design/design-system/patterns.md`
- the specific pattern/interaction document for the surface.

The main Skill should not mirror those documents.

## 4. Token decision

Before adding a value:

1. Is there already a semantic token?
2. Is the need actually layout/flow rather than a design token?
3. Is it renderer-owned and therefore needs an adapter?
4. If a new token is needed, which semantic role owns it?

Change canonical sources and regenerate outputs; never hand-edit generated token artifacts.

## 5. Component decision

Prefer in order:

1. existing Nession pattern/component;
2. installed shadcn/ui primitive;
3. add a shadcn primitive through its normal CLI/source workflow;
4. a small generic wrapper if Nession needs stable shared behavior;
5. feature-local UI only when it is truly feature-specific.

Current shadcn inventory detail is in `nession-development/references/shadcn-components.md`.

## 6. Layout / product patterns

Keep global product structure owned by Nession. Extensions/capabilities may contribute state/actions/views but should not independently redefine navigation or visual language.

Apply progressive disclosure: presence/state first, deeper controls when relevant.

## 7. Third-party renderers

For xterm, CodeMirror, markdown renderers, or other internally styled systems, utility classes on the outer component may not control the rendered result.

Put design translation at the renderer's owned adapter/theme boundary and verify computed/rendered behavior.

## 8. Validate Gate-first

During iteration:

```bash
./gates/run design-system-fast
```

Before handoff, run the appropriate full design/Web checks for the change:

```bash
./gates/run design-system-full web-eslint web-typecheck web-test-unit
```

Do not copy the live design-rule list from `design/scripts/design-gate.mjs`.

## 9. Browser proof

**All Web/App interaction and visual acceptance is Chromium + Playwright only**, using the canonical E2E browser runner and viewport matrix. This includes App/mobile gestures: emulate viewport, touch/pointer, landscape, focus, scroll, keyboard/IME-related app state and accessibility; use snapshots and deterministic assertions when visual output matters. Physical mobile devices, Mobile Safari and installed iOS Apps are not acceptance prerequisites or alternative SC proof methods. If an OS-only behavior cannot be emulated, specify a Nession-owned observable contract and note the simulator limit instead of introducing a real-device Pending gate; do not claim to have tested native Safari behavior.

UI/interaction changes require real Chromium browser inspection at the actual affected flow.

Verify:

- intended state/action works;
- responsive/app/web surface where relevant;
- no obvious regression in adjacent states;
- before/after visual evidence when the change is visual.

Use repository browser/E2E policy; do not update a baseline merely to hide a structured contract failure.

### Capability visual recipes (#3138)

A new capability surface that composes details, configuration or an operation
must reuse the approved recipe and its executable roles:

1. select `ResourceDetail` / `ConfigurationForm` / `OperationSurface` instead of
   assembling a local hierarchy;
2. identify the visual relation — a `parts` typography role or a
   `controlHeightToken` band — and its owner in
   `design/scripts/browser-design-catalog.mjs` (`CAPABILITY_VISUAL_INVARIANTS`);
3. exercise a deterministic production fixture state and compare corresponding
   parts relationally; Web/App role values may legitimately differ;
4. run `./gates/run design-system-fast`, then the canonical Browser Design
   profile / Full E2E, and inspect the relevant screenshot diff.

The full checklist and non-goals are owned by
[docs/design/design-system/validation.md](../../../docs/design/design-system/validation.md#capability-visual-recipes-3138).

## 10. Failure repair

When a design Gate fails, follow its reported owner/repair.

Never fix by:

- `eslint-disable`;
- lowering a visual/design threshold;
- adding feature-local magic values around a missing token;
- editing generated artifacts;
- changing a canonical contract only because current implementation violates it.

If the intended product behavior genuinely changed, update the canonical design owner and its proof together.

## Completion

A UI change is complete when:

- product intent aligns with Vision/Principles;
- the correct owner was used;
- relevant design/Web Gates pass;
- the real browser flow was inspected;
- canonical docs/contracts changed when the design decision changed.

Keep implementation-specific inventories out of this Skill; link to their owners instead.

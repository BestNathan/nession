---
name: nession-web-design
description: Use for Nession Web UI work that changes visual styling, layout, component selection, shadcn/ui primitives, design tokens, product patterns, UI contracts, responsive behavior, typography, spacing, surfaces, or visual validation. Guides agents to consume and extend the existing Nession design system instead of inventing feature-local styling.
---

# Nession Web Design

## Purpose

Use this skill when a Web task can change **how Nession looks, composes, or behaves as UI**.

This skill is an implementation workflow for consuming and extending Nession's existing design system. It is **not** a design source of truth and must not become a second copy of token values, product rules, pattern semantics, or contract data.

The governing chain remains:

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
design/tokens/* + design/contracts/*
    ↓
components / patterns
    ↓
shipping UI
```

The job of this skill is to answer:

> Given an approved product/design intent, which existing design-system layer owns the implementation, how do I extend that layer if vocabulary is missing, and how do I prove the result stayed inside the system?

## When to load this skill

Load it before implementing work involving any of the following:

- layout, spacing, alignment, density, sizing, typography, surfaces, radius, elevation, color, or motion;
- creating or changing shared UI components;
- adding or updating a shadcn/ui primitive;
- Session / Terminal / Workspace / capability UI patterns;
- Web/App presentation differences;
- design tokens or generated design artifacts;
- executable UI contracts or visual baselines;
- visual bugs such as misalignment, inconsistent control sizes, wrapping, baseline drift, or local magic metrics;
- third-party rendered UI such as xterm or CodeMirror when Nession styling must reach the final rendered result.

Do not load it for pure backend/protocol work with no user-facing UI consequence.

## Iron law: find the owner before writing styles

Do not begin a UI change by inventing CSS or Tailwind classes.

First identify the canonical owner of the decision:

```text
Product relationship / presence / hierarchy
    -> docs/design product / IA / interaction / workspace / pattern docs

Visual meaning and reusable values
    -> docs/design/visual-language.md
    -> design/tokens/*

Generic interaction primitive
    -> web/src/components/ui/* (prefer shadcn)

Reusable Nession product composition
    -> docs/design/design-system/patterns/*
    -> product pattern implementation

Measurable stable consequence
    -> design/contracts/*

Feature-specific state/composition
    -> web/src/features/* or web/src/app/*
```

If the correct owner is missing vocabulary, extend that owner. Do **not** hide the missing design concept inside a feature-local class string.

## Read progressively, not all at once

Always start with the smallest relevant slice. Do not flood context with the whole design tree.

1. Read `VISION.md` and `PRINCIPLE.md` for any product-facing change.
2. Read `docs/design/README.md` to locate the canonical downstream owner.
3. Read only the relevant product/interaction/visual document for the task.
4. For implementation details, read the relevant design-system owner:
   - `docs/design/design-system/tokens.md`
   - `docs/design/design-system/components.md`
   - `docs/design/design-system/patterns.md` and the relevant `patterns/*.md`
   - `docs/design/design-system/contracts.md`
   - `docs/design/design-system/validation.md`
5. Inspect the existing production component/pattern and its tests before changing it.

`web/CLAUDE.md` is the always-read Web entrypoint. It is not a substitute for the canonical owner above.

## The layer model

The implementation layers are related, but not every UI decision passes through every layer.

```text
Primitive tokens      raw scales / source material
       ↓
Semantic tokens       generic UI meaning
       ↓
Domain tokens         Nession domain meaning where needed

Experience tokens     Web/App density, sizing, touch/pointer differences
       ↓
Generic primitives    Button / Input / Dialog / Tabs / ...
       ↓
Product patterns      Session / Workspace / Terminal / capability semantics
       ↓
Feature / screen      state + contextual composition
```

Important boundaries:

- **Primitive token** is source material, not a product-component API.
- **Semantic token** names generic visual meaning such as surface/text/border/action roles.
- **Domain token** names Nession-owned domain meaning when generic semantic vocabulary is insufficient.
- **Experience token** specializes Web/App presentation such as control density or touch sizing. It does not define product IA.
- **Generic primitive components** remain product-agnostic. They may consume Semantic + Experience values but must not learn Session/Workspace/capability policy.
- **Product patterns** may combine generic primitives with Domain/Experience meaning and product interaction rules.
- **Feature/screens** compose approved patterns and state. They should not create a parallel visual vocabulary.

Do not force a pass-through token merely to make the diagram look complete. Use the lowest canonical layer that actually owns the meaning.

## Token decision tree

Before adding a value, ask what the value *means*.

```text
Is it raw palette/scale/source material?
    -> Primitive

Is it generic UI meaning independent of Nession domain?
    -> Semantic

Is it a real Nession domain/state meaning used across product surfaces?
    -> Domain

Is it specifically a Web/App presentation difference
(density, control size, touch target, safe-area behavior, etc.)?
    -> Experience

Is it about presence, navigation, hierarchy, or interaction policy?
    -> NOT a token; use interaction/pattern/contract layers

Is it only needed to patch one screenshot or one feature?
    -> stop; look for an existing owner or prove the concept is reusable first
```

Rules:

- Product/feature code must not consume Primitive palette values directly.
- Do not use arbitrary literal colors or create a local palette.
- Do not encode current shell topology into token names unless the product relationship is truly stable.
- Same resolved value does not make two token names interchangeable. Semantic identity matters.
- Generated files under `design/generated/` are outputs. Never hand-edit them.

When adding/changing token source:

```bash
just tokens-gen
just tokens-check
just design-test
```

Commit source and generated output together when generation changes tracked artifacts.

## Component decision tree

When UI needs a control or interaction primitive:

```text
Need a UI primitive
    ↓
Does Nession already have the generic primitive?
    ├─ yes -> reuse it
    └─ no
        ↓
Does shadcn provide it?
    ├─ yes -> add it with the CLI
    └─ no  -> create the smallest justified generic primitive
        ↓
Normalize it into Nession's design system
        ↓
Compose product semantics in a pattern/feature layer
        ↓
Validate
```

Before hand-rolling anything, inspect:

`.claude/skills/nession-development/references/shadcn-components.md`

The inventory is a convenience reference, not design truth. Verify the current tree if the inventory looks stale.

## shadcn workflow: add -> normalize -> consume -> validate

shadcn is an **upstream source of generic primitive code**. It is not Nession's visual language.

Install through the CLI only:

```bash
cd web
npx shadcn@latest add <component-name> --yes
```

Adding the file is only the import step. Before using or merging the generated component, review it against Nession's system.

### 1. Keep the primitive generic

A file under `web/src/components/ui/` must not encode Nession-specific concepts such as:

- Session / Agent / Workspace / Terminal semantics;
- capability lifecycle or presence rules;
- permanent product navigation assumptions;
- feature-specific labels or state machines.

Those belong in product patterns, `features/*`, or `app/*`.

### 2. Normalize visual vocabulary

Review generated classes for:

- raw/upstream palette assumptions;
- arbitrary colors or literal CSS values;
- control/row/icon geometry that conflicts with Nession Experience tokens;
- radius, surface, border, elevation, or typography decisions that bypass canonical tokens;
- Web/App differences that should be represented by Experience semantics rather than ad-hoc viewport conditionals.

If the primitive cannot express the approved design with current vocabulary, extend the canonical token/recipe owner first.

### 3. Preserve accessibility behavior

Keep or improve the upstream interaction/accessibility semantics. Icon-only controls need an accessible name and the project's established tooltip/accessibility treatment where applicable.

Do not trade away focus behavior, keyboard navigation, touch target requirements, or reduced-motion behavior for visual matching.

### 4. Validate after normalization

At minimum run the transitional design checks described below. For an actual visual or interaction change, also verify the rendered result in the browser.

## Primitive vs pattern

Use this question:

> Could this component make sense in another product without knowing what a Session, Workspace, Agent, or capability is?

- **Yes** -> it may be a generic primitive.
- **No** -> it is a Nession product pattern/composition or feature component.

Examples:

```text
Button / Dialog / Tabs / Popover
    -> generic primitives

SessionList / TerminalCapsule / WorkspaceNavigation
    -> Nession patterns

"Git diff panel for the current Workspace"
    -> feature/capability view composed from primitives/patterns
```

Do not create branded forks of generic primitives just to create product identity. Product identity comes from hierarchy, contextual presence, spacing, typography, surfaces, motion, and coherent composition.

## Layout semantics and layout primitives

A **layout primitive** is a reusable component/recipe that consumes existing tokens and expresses a stable spatial relationship. It is not a new token layer.

Potential examples are concepts such as stack/inline/control-group/split/surface, but do not invent them preemptively.

Before creating a layout primitive, require evidence that:

- the same spatial relationship appears in multiple independent consumers;
- it represents a stable semantic relation rather than merely shortening a Tailwind string;
- repeated implementations have drifted or are likely to drift in gap/alignment/wrap/baseline/responsive behavior;
- the abstraction reduces implementation freedom instead of creating a universal layout DSL.

A one-off screen composition may remain ordinary flex/grid composition. It still must use the approved token vocabulary and must not invent feature-local design metrics.

If a stable product pattern needs measurable layout guarantees, express those consequences in `design/contracts/*` instead of relying only on a helper component name.

## How to extend the system

### Missing token

1. Identify whether the owner is Primitive, Semantic, Domain, or Experience.
2. Confirm the concept is reusable and not actually product presence/layout policy.
3. Change `design/tokens/*`.
4. Regenerate/check outputs.
5. Update token tests/contrast rules when the meaning requires it.
6. Migrate consumers to the semantic name; do not keep an untracked parallel literal.

### Missing generic component

1. Check the installed inventory and current `components/ui` tree.
2. Prefer shadcn CLI when an upstream primitive exists.
3. Normalize the generated primitive to Nession tokens/experience rules.
4. Keep product semantics outside the primitive.
5. Add focused component tests when behavior or variants warrant them.

### Missing product pattern

1. Confirm the relationship is product-level and repeated/stable enough to name.
2. Locate/update the canonical pattern prose under `docs/design/design-system/patterns/`.
3. Compose generic primitives rather than creating a parallel base component kit.
4. Use Domain/Experience semantics where appropriate.
5. Add/update a contract only for stable, measurable consequences.
6. Update tests/baselines together when approved shipping behavior changes.

### Missing executable contract

1. Start from an approved pattern/product rule.
2. Encode only the measurable consequence under `design/contracts/`.
3. Reference token identifiers rather than duplicating raw values.
4. Regenerate/resolve contracts.
5. Add or update browser assertions for the rule.
6. Use screenshots only for the visual remainder that structured assertions cannot express well.

```bash
just contracts-gen
just contracts-check
just design-test
```

Never weaken or delete a contract merely because current code fails it. First determine whether implementation drifted or the upstream design intentionally changed.

## Third-party renderer boundary

xterm, CodeMirror, canvas-based renderers, and similar libraries may override normal React/Tailwind styling or inject their own CSS later in the cascade.

For these boundaries:

- keep a clear adapter/owner for Nession styling;
- make the adapter consume canonical tokens rather than feature-local literals;
- verify the **computed/rendered result**, not merely that the source file contains a token-looking class;
- keep the verification focused on the important contract; do not create full-site computed-style snapshots.

If a third-party library requires a literal/API-specific representation, derive it from the canonical token source or generated artifact where possible and document the narrow boundary.

## Validation workflow

Issue #759 is intended to provide one canonical design gate for manual use, hooks, and CI. **Until that unified entrypoint exists**, use the current checks as a transitional workflow rather than treating this list as another permanent source of truth.

### Fast/static checks

From the repository root:

```bash
just design-test
just web-lint
```

These cover token/contract generation checks, executable design tests, ESLint rules, and TypeScript checks already wired by the repository.

Run relevant Web tests for changed behavior:

```bash
just web-test-unit
just web-test-integration
```

Use the smallest relevant test first while iterating; run the repository-required gate before claiming completion.

### Browser verification

For visual, layout, interaction, responsive, Terminal, Workspace, or third-party-renderer changes, static/unit checks are not sufficient.

Run the local stack according to `nession-development`, then verify with Playwright/browser tooling at the relevant canonical viewports and product states.

Check the rendered behavior that matters to the contract, for example:

- actual control size/alignment/wrapping;
- computed typography/surface values where relevant;
- focus, keyboard, touch, overflow, and scroll behavior;
- Web/App divergence at the canonical viewports;
- absence as well as presence for contextual capability UI.

If approved behavior changes a focused visual baseline, update the executable contract and baseline in the same semantic change. Do not update screenshots merely to silence a diff.

## Failure repair loop

When a design check fails, do not patch the nearest line blindly.

```text
Failure
  ↓
Which rule failed?
  ↓
Who owns that rule?
  ├─ token vocabulary/value        -> design/tokens/*
  ├─ generic primitive            -> components/ui/*
  ├─ product semantics/composition -> docs/design pattern + pattern implementation
  ├─ measurable consequence       -> design/contracts/*
  └─ implementation drift         -> feature/app code
  ↓
Fix the canonical owner or the drifting consumer
  ↓
Regenerate derived artifacts
  ↓
Run checks again
  ↓
Verify rendered result when UI changed
```

Forbidden repairs:

- `eslint-disable` or broad rule suppression;
- feature-local magic metrics that reproduce one screenshot;
- raw palette/literal values replacing a missing semantic token;
- lowering contract or visual thresholds to make CI green;
- hand-editing `design/generated/*`;
- preserving an obsolete contract merely because a screenshot currently expects it.

## Common task recipes

### "Add a new dropdown/popover/control"

1. Check `components/ui` and the shadcn inventory.
2. Reuse the installed primitive if possible.
3. If missing, add with shadcn CLI.
4. Normalize generated styles to Nession tokens/Experience semantics.
5. Keep feature semantics in the caller/pattern.
6. Run design checks and browser verification.

### "This feature needs a 34px control"

Do not write `h-[34px]` first.

Ask why it is 34px:

- existing Experience/control role -> use it;
- stable missing Experience role -> extend the token system with rationale;
- one-off attempt to make a screenshot look aligned -> redesign composition rather than adding vocabulary.

### "The pattern looks right but its token name is wrong"

Fix it. A coincidentally equal resolved pixel value does not make a semantically wrong token legal. Token identity protects future divergence between roles and experiences.

### "Tailwind class is present but the UI still renders differently"

Treat it as a renderer/cascade problem, especially for CodeMirror/xterm. Inspect the final computed/rendered result and move the adapter to the layer that actually wins the cascade; do not stack stronger arbitrary selectors without understanding ownership.

## Completion checklist

Before claiming a UI/design-system change complete:

- [ ] I identified the canonical design owner before implementing.
- [ ] I reused existing Semantic/Domain/Experience vocabulary where it already expressed the intent.
- [ ] I did not consume Primitive palette values from product/feature UI.
- [ ] I checked existing Nession primitives/patterns before creating a new one.
- [ ] If I added shadcn code, I normalized it rather than treating generated defaults as final design.
- [ ] Generic primitives remain product-agnostic; product semantics live in patterns/features.
- [ ] I did not introduce feature-local magic design metrics or a parallel visual language.
- [ ] Any new layout primitive is justified by repeated stable semantics, not convenience alone.
- [ ] Stable measurable behavior is represented by the appropriate contract rather than duplicated test constants.
- [ ] Generated design artifacts are synchronized.
- [ ] Transitional design checks pass (`just design-test`, `just web-lint`, relevant Web tests).
- [ ] A real visual/interaction change was verified in the browser/Playwright, not only by lint/unit tests.
- [ ] If an upstream design decision changed, pattern/docs/contracts/baselines were converged together.

## Relationship to other skills

- `nession-development` owns worktrees, general implementation workflow, tests, PRs, and broad shadcn inventory.
- `nession-web-design` owns the **design-system consumption/extension decision process** for Web UI work.
- `nession-cicd` owns CI/CD and deployment behavior.

When multiple skills apply, follow all of them. This skill does not override repository workflow or product/design truth.
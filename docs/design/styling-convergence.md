# Styling Source Convergence

> **Status: historical migration record.** The original `--sf-*` styling convergence work described here has been implemented. This document preserves rationale and ownership lessons; it does not define current product structure.

> Upstream for current work: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [visual-language.md](visual-language.md) → [composition.md](composition.md) → [design-system/tokens.md](design-system/tokens.md)

## Why this document exists

Nession previously had overlapping styling vocabularies across generated design tokens, Session-first shell CSS variables, raw Tailwind metrics, shadcn primitives, and capability-specific UI.

The convergence effort established a durable ownership direction:

```text
design/tokens
    ↓
design/generated
    ↓
generic primitives
    ↓
product patterns / contextual composition
    ↓
shipping UI
```

The important lesson remains valid: **one owner per reusable visual concept, without turning every layout choice into a token.**

## Completed historical work

The original migration covered:

- replacing duplicate `--sf-*` shell variables with generated Semantic / Domain / Experience tokens where appropriate;
- keeping one-off layout/composition decisions in readable design prose instead of manufacturing tokens for them;
- moving Terminal well, spacing, type, focus, and motion concerns toward shared token ownership;
- extending lint/enforcement only after the old styling path was removed;
- auditing raw control/touch metrics against Experience tokens;
- keeping shadcn primitives generic rather than forking them for product identity.

Implementation PRs such as #578 and #580 completed the main `--sf-*` removal/convergence work tracked from #561/#467.

## Durable styling principles

These rules remain useful for current and future product work:

1. **Product meaning comes before tokenization.** A token should implement an approved semantic/visual relationship, not create one.
2. **Explore → approve → abstract → tokenize → enforce.** Do not freeze exploratory layout too early.
3. **One owner per reusable concept.** If generated tokens own a value, avoid a feature-local duplicate vocabulary.
4. **Composition stays composition.** Page gutters, contextual placement, and one-off geometry remain in composition/pattern docs until repetition justifies abstraction.
5. **Do not tokenize one-offs merely to remove literal values.** A named token is not automatically better if it has no reusable semantic meaning.
6. **Lint follows maturity.** Enforcement should prevent regression after a design path is established, not block intentional exploration.
7. **Extensions use Nession's visual language.** Capability-specific UI may introduce domain semantics, but not a parallel global palette, spacing scale, or navigation chrome.

## Product-direction correction after the original migration

The original styling work was built around a more fixed Session-first shell. Since `VISION.md` and `PRINCIPLE.md` became the upstream product contract, some old composition assumptions are no longer product invariants.

In particular, styling infrastructure must not encode assumptions such as:

- every Session always has the same permanent header chrome;
- a `Terminal | Workspace` switcher must always exist;
- every Workspace capability has a permanent tab/button;
- Agent metadata must always reserve space;
- adding a capability should add proportional visible chrome.

Tokens and style rules should make approved contextual composition consistent; they should not force the composition to exist.

## Current source ownership

| Concern | Canonical owner |
|---------|-----------------|
| Product direction | `VISION.md` |
| Product design decisions | `PRINCIPLE.md` |
| Visual hierarchy / emphasis | `docs/design/visual-language.md` |
| Page/surface relationships | `docs/design/composition.md` |
| Product pattern semantics | `docs/design/design-system/patterns/*` |
| Token vocabulary | `docs/design/design-system/tokens.md` + `design/tokens/` |
| Generated values | `design/generated/` |
| Measurable layout constraints | `design/contracts/` + contracts docs |
| Generic Web primitives | `web/src/components/ui/` |

When these disagree, resolve from the top of the hierarchy downward rather than creating another styling bridge.

## Historical anti-patterns worth preventing

- Parallel CSS variable vocabularies for the same semantic value.
- Product components consuming Primitive palette values directly.
- Feature-local spacing/radius systems that bypass shared visual language.
- Token names that encode obsolete shell structure.
- Golden screenshots treated as stronger than upstream design decisions.
- A styling refactor that accidentally becomes an IA/product redesign without updating canonical docs.

## Maintenance

Do not extend this file as the plan for new product styling work. New design changes belong in the relevant canonical visual/composition/pattern/token docs, with implementation tracked by focused issues/PRs.

Keep this document as a record of why the styling source tree was converged and which mistakes should not be reintroduced.

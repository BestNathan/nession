# UI Contracts (architecture)

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [information architecture](../information-architecture.md) → [patterns](patterns.md)

Machine-readable UI contracts encode **measurable consequences of an approved product/pattern decision**. They help tooling and AI repair loops preserve layout, interaction, and accessibility constraints without turning current implementation geometry into product law.

**Tracking:** [#544](https://github.com/BestNathan/nession/issues/544)  
**Implementation:** [#545](https://github.com/BestNathan/nession/issues/545)  
**Validation:** [validation.md](validation.md)

## Core rule

> Contracts constrain implementation. They do not outrank Vision, Principles, product model, IA, or pattern semantics.

When upstream product meaning intentionally changes, the affected pattern, executable contract, implementation, and visual baseline should converge together.

An old contract is evidence of a previous approved behavior, not proof that a higher-level product decision cannot change.

## Layer stack

```text
VISION.md / PRINCIPLE.md
        ↓
Product model / IA / Interaction
        ↓
Pattern prose (semantics + progressive disclosure)
        ↓
Design Tokens (reusable values)
        ↓
UI Contracts (measurable consequences)
        ↓
Implementation
        ↓
Assertions / viewport matrix / visual regression
```

## Ownership

| Layer | Owns | Does not own |
|-------|------|--------------|
| Product / IA docs | Product relationships, presence rules, mental model | Component pixels |
| Pattern markdown | Purpose, contextual anatomy, states, progressive disclosure, Web/App meaning | Raw duplicated values |
| Tokens | Reusable values and semantic vocabulary | Product presence/navigation policy |
| Contracts | Testable layout/visibility/overflow/touch constraints derived from patterns | Product direction; capability entitlement to UI |
| Assertions / visual baselines | Enforcement of the current contract | Design truth |

Development skills may point at contracts; they must not create a parallel product/design source of truth.

## Contract maturity

Do not encode every exploratory UI choice immediately.

A relationship is ready for a rigid executable contract when:

- the upstream product/pattern meaning is clear;
- the rule is measurable and useful to enforce;
- the rule is expected to remain stable enough that automated enforcement reduces drift rather than blocking exploration.

Prefer delaying a narrow contract over prematurely freezing an uncertain shell anatomy.

## What contracts should express

Examples of useful measurable consequences:

| Field / concept | Role |
|-----------------|------|
| `wrap` | Whether a stable element must stay single-line |
| `heightToken` / `minHeightToken` | Approved Experience token reference |
| `overflow` | `clip` / `menu` / `sheet` / `scroll` / `wrap` strategy |
| `align` | Measurable alignment intent |
| `minWidth` / `maxWidth` | Token or named semantic bound |
| `scrollOwner` | Which surface owns scrolling |
| `touchTargetToken` | App touch accessibility |
| `visibility` | Context/experience-dependent visibility rule |
| `allowedPrimitive` | Allowed composition primitive when stable |
| `patternRef` | Canonical pattern prose owner |

Contracts should increasingly support **contextual presence**, not only static viewport presence.

For example, a capability entry may need conditions such as:

```text
unavailable -> absent
available   -> discoverable, not necessarily persistent
relevant    -> direct presence allowed
active      -> stronger contextual presence allowed
```

The exact schema is an implementation concern, but the product meaning must come from upstream pattern specs.

## What contracts must not encode

Avoid turning historical shell choices into universal invariants, such as:

- a permanent `Terminal | Workspace` switcher must always exist;
- every registered Workspace capability must own a visible tab;
- a healthy Agent badge must always occupy SessionHeader space;
- a fixed tool enum defines the Workspace;
- one Agent equals one Workspace;
- one Location failure hides every Workspace resource.

If existing executable contracts encode these assumptions, classify them as **implementation convergence debt** until the corresponding UI is intentionally migrated.

## Storage

Platform-neutral executable contracts live under:

```text
design/contracts/
  schema.json
  global.json
  categories/
  patterns/
  viewports.json
```

Generated output remains under `design/generated/` and must not be hand-edited.

`docs/design/` owns the human-readable product/design architecture; executable contract files implement a subset of it.

## Inheritance

Shared measurable constraints may inherit:

```text
global.rules
  ↓
category.<chrome|control|list-row|surface|...>
  ↓
pattern.<...>
  ↓
override.<rare local>    // requires rationale
```

Web and App blocks remain explicit where interaction differs. Neither experience silently inherits the other's navigation strategy.

## Context versus viewport

Viewport is only one source of UI state.

Contracts may also need to consider:

- Session/attachment/connectivity state;
- Workspace Location/source availability;
- capability lifecycle (`unavailable -> available -> relevant -> active`);
- whether a deeper surface is explicitly opened;
- whether metadata is redundant or needed for disambiguation.

Do not force context-sensitive product behavior into breakpoint-only rules.

## Initial / current coverage

Existing contracts were created around the Session-first shell and remain useful for implementation stability. High-value coverage includes:

- Session navigation rows;
- compact Session chrome where still rendered;
- Terminal surface/capsule geometry;
- Workspace contextual navigation where the current implementation exposes it;
- touch targets and scroll ownership;
- shared control categories.

Names such as `workspace-navigation` or old toolbar/switcher contracts describe current implementation surfaces, not permanent product topology.

## Change protocol

When an intentional product change invalidates a contract:

```text
1. confirm upstream Vision / Principle / product-model intent
2. update canonical pattern/design prose
3. update shipping implementation
4. update executable contract/schema if needed
5. update assertions and focused visual baselines
6. review the diff as one semantic change
```

Do not update a screenshot or relax a contract silently to make a test green. The change should be traceable to the upstream product decision.

## Non-goals

- A second design system.
- Encoding product direction in JSON.
- One contract file per component regardless of value.
- Freezing exploratory feature placement too early.
- Treating current fixtures/screenshots as canonical product policy.
- Letting extensions publish arbitrary global layout contracts that bypass Nession's product language.

## Maintenance

Keep one canonical owner for each rule. Pattern prose owns product semantics; contracts own measurable consequences. When they disagree, determine whether the implementation is stale or the product decision changed, then converge the lower layers intentionally.

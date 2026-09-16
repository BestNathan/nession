# Design System Inventory

> Audit companion to [tokens](tokens.md), [components](components.md), [patterns](patterns.md), [contracts](contracts.md), and [validation](validation.md). Tracked by [#760](https://github.com/BestNathan/nession/issues/760).

This document records the **current coverage conclusions and ownership gaps** in Nession's design system. It is not a new source of token values, product rules, component APIs, or contract data.

The canonical chain remains:

```text
Intent / product rule
    ↓
Canonical owner document
    ↓
Token / primitive / pattern / contract
    ↓
Production consumer
    ↓
Validation
```

The inventory exists to make holes in that chain visible. A key existing in JSON is not evidence that the corresponding UI is implemented.

## Repeatable evidence

The audit is generated from the repository rather than maintained as a hand-edited token/component spreadsheet:

```bash
# Human-readable Markdown evidence
just design-inventory

# Full machine-readable graph / counts
just design-inventory-json

# Deterministic integrity check used by Web CI
just design-inventory-check
```

`design/scripts/audit-design-system.mjs` currently inspects:

- Primitive / Semantic / Domain / Web Experience / App Experience tokens;
- token-to-token references and downstream references;
- shipping consumers under `web/src` (tests excluded);
- `web/src/components/ui` import consumers and upstream bases;
- repeated cross-file Tailwind layout signatures;
- raw typography classes and Experience typography tokens;
- pattern/category contracts and browser-evidence files.

The scanner is deliberately **lexical evidence**, not a compiler or a replacement for Playwright. Its job is to reveal suspicious coverage and repetition cheaply enough to run on every change.

## Token inventory model

The report represents every token with these distinct relationships:

```text
source token
  ├─ upstream refs
  ├─ downstream token refs
  ├─ direct production consumers
  └─ effective production consumers
       (direct consumers reachable through downstream token refs)
```

This distinction matters. A Primitive should normally have no direct product-component consumer, while still being actively used through Semantic or Domain vocabulary.

Semantic light/dark entries are collapsed to one logical semantic identity in the report. Their light/dark source paths and references remain visible. This prevents the inventory from counting `semantic.background` twice merely because it has two theme mappings.

### Zero-consumer classification

Every token with zero **effective** shipping consumers receives an explicit status in the report:

| Layer | Default zero-consumer status | Meaning |
|---|---|---|
| Primitive | `intentional` | Primitive is source material, not a product API. Lack of direct shipping use is legal but remains visible. |
| Semantic | `reserved` | Shared semantic vocabulary exists but currently does not reach shipping UI. shadcn compatibility roles such as chart/sidebar remain explicit rather than pretending to be used. |
| Domain | `reserved` | Canonical product vocabulary exists but is not currently surfaced. This is especially important for deliberately quiet/absent healthy states. |
| Experience | `reserved` | Platform-specific vocabulary exists but currently has no shipping consumer and should be reviewed before being extended further. |

`reserved` does **not** mean “implemented.” It means “kept deliberately until a focused consumer/removal decision is made.” An obsolete or duplicate conclusion remains a human design decision and should become a small follow-up change rather than being inferred from equal values.

This catches the class of problem seen in #756: `workspace.navigation` or an editor token can exist, resolve successfully, and still show zero effective production consumers. The report therefore exposes both its mapping and its actual reach into shipping code.

### Same value is not same meaning

The inventory intentionally does not deduplicate tokens by resolved value.

- same value + different semantic role may be correct;
- same semantic role + different Web/App value may be a legitimate Experience difference;
- same role + accidental divergent value is a drift candidate;
- wrong token identity remains wrong even when two tokens currently resolve to the same px/color.

That preserves the lesson from #742: token identity is part of the contract.

### Current mapping checkpoint

The current source now has the missing neutral chrome concept that #756 exposed:

```text
domain.workspace.navigation
    -> semantic.surface
    -> primitive.{light|dark}.neutral.surface
```

The audit should continue to show whether that chain reaches a production consumer; the mapping being correct is only half of the requirement.

## Typography audit

### Current state

Typography is **partially covered but not yet expressed as a small shared semantic role vocabulary**.

The Primitive layer has only a shared body scale:

```text
primitive.typography.size
primitive.typography.lineHeight
```

Several real information roles are instead encoded as highly specific Experience tokens, especially on Web:

```text
experience.web.shell.nodeFontSize
experience.web.shell.sessionRowTitleFontSize
experience.web.shell.sessionRowMetaFontSize
experience.web.shell.footFontSize
experience.web.shell.sectionHeadFontSize
experience.web.composer.captionFontSize
experience.web.composer.quickKeyFontSize
experience.web.composer.physKeyFontSize
experience.web.workspace.treeFontSize
experience.web.workspace.editorFontSize
experience.web.workspace.editorHeadFontSize
```

At the same time, production components still use ordinary Tailwind typography classes. The inventory reports the frequency/files for `text-*`, `font-*`, `leading-*`, and `tracking-*` so drift can be measured instead of guessed.

### Coverage conclusion

| Information role | Current coverage | Conclusion |
|---|---|---|
| Primary work / body | Primitive body scale + component defaults | **Partial.** Value exists, semantic role is not consistently named. |
| Secondary / metadata | `semantic.text-secondary` for color plus several feature-specific font sizes | **Fragmented.** Color meaning and typographic hierarchy are not represented by one reusable role. |
| Section / title hierarchy | Shell/session-specific sizes and ordinary Tailwind classes | **Missing shared role.** Do not add a large type scale; define only roles proven across surfaces. |
| Caption / quiet context | Composer caption + muted color conventions | **Partial.** Role is local to composer instead of generally reusable. |
| Code / terminal / monospace metadata | Tree/editor/shell metadata use local Experience decisions | **Fragmented but intentional in font family.** Needs shared role names before more local tokens are added. |
| Control labels | Mostly primitive/component styling | **Implicit.** Keep in primitive recipes unless repeated product-level drift appears. |
| Web / App differences | Experience layer supports real platform divergence | **Architecturally correct.** Platform values should specialize a shared role, not invent unrelated role names. |

### Decision

Do **not** add a broad typography scale in this audit. The smallest justified follow-up is to define a handful of information roles — body, metadata, section/title, quiet/caption, code/mono metadata — and then decide whether each belongs in token vocabulary or a reusable typography recipe.

The canonical owner for that follow-up is [visual-language.md](../visual-language.md) + [tokens.md](tokens.md), not an individual feature component.

## Layout primitive audit

A repeated `flex` is not automatically a missing component. The report clusters literal class compositions into structural signatures such as:

```text
flex + items-center + gap-*
flex + flex-col + gap-*
flex + justify-between + items-center
inline-flex + items-center + gap-*
grid + gap-* + grid-cols-*
```

For each repeated signature it reports occurrence count and independent files. It separately reports arbitrary design metrics (`h-[…]`, `gap-[…]`, `rounded-[…]`, etc.) because those are stronger drift evidence than ordinary composition.

### Decision threshold

A layout primitive is justified only when all are true:

1. the relationship appears in multiple independent consumers;
2. it represents a stable semantic relationship rather than class-string compression;
3. gap/alignment/wrap/baseline/responsive behavior can drift in a harmful way;
4. the abstraction reduces freedom instead of creating a generic layout DSL.

### Current conclusions

- **Do not introduce a universal `Stack`/`Inline` kit just because vertical/horizontal flex signatures repeat.** Those relationships are too generic without a stable semantic guarantee.
- **Control/action groups are the strongest candidate for a future layout primitive** when the generated evidence shows the same control alignment, spacing, wrapping, and responsive behavior across independent surfaces. A follow-up should prove that with concrete consumers before naming the API.
- **Workspace master/detail remains product composition**, not a generic `Split` primitive. Its tree/editor geometry encodes Workspace meaning and currently belongs to Workspace composition + Experience tokens/contracts.
- **Surface/panel composition is not a new token layer.** If a reusable surface abstraction emerges, it must consume existing Semantic/Experience tokens and carry a stable relationship, not become another source of spacing values.

So #760 deliberately adds **evidence before abstraction**, not a speculative layout-component library.

## Component / shadcn boundary

The executable inventory recomputes `components/ui` usage rather than copying the component table into this document. The more detailed human reference remains `.claude/skills/nession-development/references/shadcn-components.md`.

The classification model is:

| Classification | Meaning |
|---|---|
| `nession-normalized primitive` | Generic shadcn/base primitive consumed through Nession Semantic/Experience vocabulary. |
| `wrapper/adapter` | Thin wrapper around a generic primitive/API; allowed while it stays small and does not acquire product-presence policy. |
| `candidate-removal` | Installed primitive with zero production import consumers. |
| `wrapper/adapter-unused` | Wrapper with no production consumer; must justify retention or be removed. |

The current known removal candidates from the pre-audit inventory are:

```text
Resizable
Sheet
Sonner
Toggle
```

The audit tool verifies these from the current tree on every run rather than assuming that list stays true. In particular, `Sonner` is a useful boundary smell: the wrapper can exist while `main.tsx` imports the package directly, so “file exists in components/ui” does not prove the adapter is actually the integration boundary.

`ConnectionStatusBadge` and `RefreshButton` are accepted as thin wrappers/adapters today. If either begins to own Session/Workspace/capability presence policy, it should move upward into a product pattern/feature instead of expanding `components/ui` semantics.

No product-specific primitive should be added to `components/ui` merely because shadcn generated a convenient file.

## Pattern / primitive boundary

Use the existing ownership chain:

```text
components/ui
    generic interaction primitive
        ↓
product pattern
    Nession semantics + stable interaction/composition
        ↓
feature / app
    state + contextual composition
```

The audit does not treat a wrapper name or component reuse count as proof that a product pattern exists. A product pattern earns a name when it owns stable Nession semantics and/or measurable consequences.

Conversely, not every documented pattern needs an executable geometry contract. Only stable measurable consequences belong in `design/contracts`; product presence and hierarchy stay upstream in product/interaction/pattern documents.

## Contract / validation coverage

The inventory reports the validation surfaces separately instead of pretending they are interchangeable:

| Layer | Owns | Current evidence |
|---|---|---|
| Static/token | Reference integrity, generated-token consistency, forbidden low-level styling | token generator/tests, contract resolver/tests, lint, inventory check |
| Executable contract | Stable measurable consequence of an approved pattern | `design/contracts/patterns/*`, category/global contracts |
| Browser measurement | Rendered geometry/state/interaction in canonical contexts | Web E2E/Playwright files enumerated by the inventory |
| Visual baseline | Visual remainder that structured assertions do not encode economically | [validation.md](validation.md) and focused baseline workflow |

Current pattern contracts cover at least:

```text
SessionHeader
SessionItem
SessionList
TerminalCapsule
WorkspaceNavigation
```

That is intentionally smaller than the documented pattern catalog. The gap is not automatically a bug: patterns such as contextual presence may be better protected by state/browser assertions than by duplicated pixel contracts.

The rule for future coverage is:

> One design fact should have one canonical owner, with downstream checks proving consequences rather than restating the same truth independently in lint, contract JSON, and screenshots.

This output is intended to feed #759's unified gate without making #760 itself a second enforcement framework.

## Third-party renderer boundary

xterm and CodeMirror are special cases. A token may have no ordinary React/Tailwind consumer because an adapter or generated object carries it into the renderer.

The inventory therefore treats Primitive source material as intentional even when no direct product source matches it. That does not remove the requirement to verify the final renderer:

```text
canonical token
    -> generated/adapter representation
    -> third-party renderer
    -> computed/rendered browser assertion
```

#757 remains the reference failure mode: source-level class presence is insufficient when later injected renderer styles win the cascade.

## Minimal follow-up slices

The audit should produce small implementation slices, not another open-ended “design-system rewrite.” Current priorities are:

### A. Typography role vocabulary

Define the minimal cross-surface information roles proven above, then migrate a small pilot set of shell/workspace/composer consumers. Do not create a full type scale and do not move platform density out of Experience.

### B. Unused primitive cleanup

For each current `candidate-removal` (`Resizable`, `Sheet`, `Sonner`, `Toggle` at the time of this audit), either:

- remove it and any dead dependency/support file; or
- attach a concrete near-term consumer and classify it as reserved with rationale.

Do this as a mechanical cleanup slice, not together with product redesign.

### C. Layout primitive only after evidence

Use `just design-inventory` to pick one repeated semantic relationship with multiple independent consumers and demonstrated drift risk. Control/action grouping is the first candidate to evaluate. If the evidence is only generic `flex + gap`, make **no change**.

### D. Reserved-token review

Review zero-effective-consumer Domain/Experience entries in small families. For each, decide `reserved`, `obsolete`, or wire the intended consumer. Never bulk-delete based on count alone.

### E. Feed coverage evidence into #759

The future unified design gate should consume the same inventory/check implementation rather than reimplementing token/component/layout scans in hooks and CI.

## What this audit intentionally does not do

- no visual identity redesign;
- no automatic dedupe by resolved value;
- no mass token deletion;
- no universal layout DSL;
- no shadcn fork;
- no assumption that a zero-consumer product state must be visible;
- no assumption that a contract or screenshot is upstream product truth;
- no new layout primitive without real cross-consumer evidence.

## Maintenance

Run the inventory when changing tokens, `components/ui`, shared typography, reusable layout composition, or contracts. CI runs the integrity form through `web-lint` so dangling token references or an empty component inventory cannot silently land.

When the report exposes a new zero-consumer item, the important question is not “can we make the warning disappear?” It is:

> Is this concept intentionally reserved, genuinely obsolete, duplicated, or simply not wired into the approved UI yet?

Answer that at the canonical owner, then make the smallest follow-up change.

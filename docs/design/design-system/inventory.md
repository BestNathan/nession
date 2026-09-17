# Design System Inventory

> Audit/evidence companion to [tokens](tokens.md), [components](components.md), [patterns](patterns.md), [contracts](contracts.md), and [validation](validation.md). Tracked by [#760](https://github.com/BestNathan/nession/issues/760).

This document records **coverage findings and ownership gaps**. It is not a new source of token values, product rules, component APIs, or contract data.

The audited chain is:

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

A JSON key or component file existing is not evidence that the design capability reaches shipping UI.

## Repeatable evidence

```bash
# Human-readable Markdown report
just design-inventory

# Full machine-readable graph
just design-inventory-json

# Deterministic integrity check (also a layer of the canonical design gate)
just design-inventory-check
```

`design/scripts/audit-design-system.mjs` scans:

- Primitive / Semantic / Domain / Web Experience / App Experience tokens;
- upstream refs, downstream refs, direct production consumers, and effective consumers;
- `web/src/components/ui` consumers and upstream base packages;
- repeated cross-file Tailwind layout signatures and arbitrary metrics;
- raw typography classes plus Experience typography roles;
- pattern/category contracts and browser-evidence files.

It is deliberately **lexical evidence**, not a compiler and not a replacement for browser validation.

## Snapshot: 2026-09-17

The first CI execution of the audit against the #760 branch reported:

```text
logical tokens                  286
zero effective consumers         78
  reserved                       46
  intentional                    32
missing token refs                1
components/ui .tsx files         23
unused installed .tsx             0
repeated layout relationships    23
arbitrary metric signatures      56
raw typography class signatures 26
Experience typography tokens     22
pattern contracts                 5
```

The most important result was not the counts: the audit immediately found a real semantic-reference defect that the generated CSS check did not catch:

```text
domain.file.created -> semantic.action   # semantic.action does not exist
```

The correct existing owner is `domain.action`, which already maps directly to the theme-scoped Primitive action axis. The #760 implementation therefore repairs the reference to:

```text
domain.file.created -> domain.action -> primitive.{theme}.action
```

This is a concrete example of why token identity must be audited instead of checking only the final CSS value. The old reference could still emit `var(--action)` and appear visually correct while pointing at the wrong semantic layer.

## Token inventory model

Every logical token exposes:

```text
source token
  ├─ upstream refs
  ├─ downstream token refs
  ├─ direct production consumers
  └─ effective production consumers
       (shipping consumers reachable through downstream refs)
```

Semantic light/dark mappings are collapsed to one logical semantic identity while retaining both source paths. This measures vocabulary instead of counting theme duplication.

### Zero-consumer status

Every zero-**effective**-consumer token receives an explicit status:

| Layer | Default status | Meaning |
|---|---|---|
| Primitive | `intentional` | Source material is not a product-component API. |
| Semantic | `reserved` | Shared semantic vocabulary currently has no shipping reach; compatibility vocabulary remains visible until deliberately removed. |
| Domain | `reserved` | Canonical product vocabulary exists but is not currently surfaced; this must not be counted as implemented UI. |
| Experience | `reserved` | Platform vocabulary exists but currently has no shipping consumer and requires review before further expansion. |

`reserved` means **kept deliberately pending a focused decision**, not “implemented.” `obsolete` and `duplicate` require a design/ownership decision and should become small follow-up changes rather than being inferred from equal resolved values.

This makes #756-style false completion visible: a token can exist, resolve, and still have zero effective production consumers.

### Same value is not same meaning

The inventory never deduplicates by resolved value:

- same value + different semantic role may be correct;
- Web/App may legitimately diverge at Experience;
- same role + accidental divergent value is a drift candidate;
- wrong token identity remains wrong even when the rendered value is currently identical.

That preserves the #742 lesson: **token identity is part of the contract**.

### Mapping checkpoint

The earlier #756 Workspace correction is now represented as:

```text
domain.workspace.navigation
    -> semantic.surface
    -> primitive.{light|dark}.neutral.surface
```

The audit separately shows whether that chain reaches shipping consumers; a correct mapping alone is not proof of implementation.

## Typography audit

### Finding

Typography is **partially covered but fragmented**.

The Primitive layer only has the shared body scale:

```text
primitive.typography.size
primitive.typography.lineHeight
```

Real information roles are then expressed through many local Experience tokens, for example:

```text
experience.web.shell.nodeFontSize
experience.web.shell.sessionRowTitleFontSize
experience.web.shell.sessionRowMetaFontSize
experience.web.shell.sectionHeadFontSize
experience.web.composer.captionFontSize
experience.web.workspace.treeFontSize
experience.web.workspace.editorFontSize
experience.web.workspace.editorHeadFontSize
```

Production code also still uses ordinary `text-*`, `font-*`, `leading-*`, and `tracking-*` classes. The executable report records their frequency and files.

### Coverage conclusion

| Role | Conclusion |
|---|---|
| Primary work / body | Value exists; reusable semantic role is only partial. |
| Secondary / metadata | Fragmented between color semantics and feature-specific font sizes. |
| Section / title hierarchy | Missing a small shared role vocabulary. |
| Caption / quiet context | Partially represented, often composer-local. |
| Code / terminal / monospace metadata | Font-family distinction is intentional; role naming is fragmented. |
| Control labels | Mostly implicit in primitive recipes; do not promote unless repeated drift appears. |
| Web / App divergence | Experience is the correct layer for platform values, but it should specialize shared roles rather than invent unrelated meanings. |

### Decision

Do **not** create a broad type scale in #760. A follow-up may define only the proven information roles — body, metadata, section/title, quiet/caption, code/mono metadata — with [visual-language.md](../visual-language.md) + [tokens.md](tokens.md) as canonical owners.

## Layout primitive audit

The scanner groups structural class relationships such as:

```text
flex + items-center + gap-*
flex + flex-col + gap-*
flex + justify-between + items-center
inline-flex + items-center + gap-*
grid + gap-* + grid-cols-*
```

It separately reports arbitrary design metrics such as `h-[…]`, `gap-[…]`, `rounded-[…]`, and `text-[…]`, because these are stronger drift evidence than ordinary flex/grid composition.

A layout primitive is justified only when all are true:

1. multiple independent consumers express the same relationship;
2. the relationship has stable semantics, not merely a repeated class string;
3. alignment/gap/wrap/baseline/responsive behavior has meaningful drift risk;
4. the abstraction reduces implementation freedom instead of becoming a universal layout DSL.

### Conclusion

- Do **not** introduce generic `Stack` / `Inline` components merely because flex signatures repeat.
- Control/action grouping is the first candidate worth evaluating if the generated evidence demonstrates the same semantic behavior across independent surfaces.
- Workspace master/detail is product composition, not a generic `Split` primitive.
- “Surface” or “panel” is not a new token layer. Any future reusable layout primitive must consume existing Semantic/Experience vocabulary.

So #760 adds **evidence before abstraction**, not a speculative layout kit.

## Component / shadcn boundary

The executable inventory classifies `web/src/components/ui` as:

| Classification | Meaning |
|---|---|
| `nession-normalized primitive` | Generic shadcn/base primitive consumed through Nession vocabulary. |
| `wrapper/adapter` | Thin adapter over a primitive/API; allowed while it stays generic. |
| `candidate-removal` | Installed primitive with zero production import consumers. |
| `wrapper/adapter-unused` | Wrapper with no production consumer. |

### Current finding

The previous manually maintained shadcn reference (2026-09-14) still listed `Resizable`, `Sheet`, `Sonner`, and `Toggle` as installed-but-unused. They are now absent from `web/src/components/ui`.

The executable snapshot sees:

```text
23 .tsx files
= 21 generic primitives
+ 2 wrappers/adapters
= 0 installed-unused .tsx components
```

The shadcn reference has been updated to stop hand-maintaining usage counts and instead point to `just design-inventory`. This is itself evidence that a repeatable inventory is preferable to a static table.

### Boundary review

`RefreshButton` remains a small generic adapter. `ConnectionStatusBadge` is worth continued boundary review because it imports socket connection state directly. If it grows Session/Workspace/capability presence policy, those semantics should move upward into a product pattern/feature rather than making `components/ui` domain-aware.

## Pattern / primitive boundary

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

A wrapper name or reuse count does not prove that a product pattern exists. A pattern earns a name by owning stable Nession semantics and/or stable measurable consequences.

Likewise, not every documented pattern needs a pixel contract. Product hierarchy/presence remains upstream; `design/contracts` owns only stable measurable consequences.

## Contract / validation coverage

The four validation surfaces remain separate:

| Layer | Owns |
|---|---|
| Static/token | Reference integrity, generated-token consistency, forbidden low-level styling, inventory integrity |
| Executable contract | Stable measurable consequences of approved product patterns |
| Browser measurement | Rendered geometry/state/interaction in canonical contexts |
| Visual baseline | Visual remainder that structured assertions do not economically encode |

Current executable pattern contracts cover five patterns:

```text
SessionHeader
SessionItem
SessionList
TerminalCapsule
WorkspaceNavigation
```

That is intentionally smaller than the documented pattern catalog. A missing pixel contract is not automatically a gap; contextual presence can be better protected through state/browser assertions.

The rule remains:

> One design fact has one canonical owner. Downstream checks prove consequences; they do not restate the same truth independently in lint, contract JSON, and screenshots.

The inventory check is one layer of the canonical design gate (`just design-check`, `design/scripts/design-gate.mjs`). Hooks and CI select a gate profile; neither reimplements this scanner, and `web-lint` no longer carries it.

## Third-party renderers

xterm and CodeMirror may bypass normal React/Tailwind consumption. Their chain is:

```text
canonical token
    -> generated/adapter representation
    -> third-party renderer
    -> computed/rendered browser assertion
```

#757 remains the reference failure mode: source-level class/token presence is not proof when renderer-injected styles win later in the cascade.

## Minimal follow-up slices

1. **Typography roles:** define a small evidence-backed role vocabulary; migrate a pilot group only.
2. **Reserved-token review:** review zero-effective-consumer Domain/Experience families and decide reserved / obsolete / wire consumer; never bulk-delete by count.
3. **Layout primitive:** evaluate one relationship at a time; if evidence is only generic flex+gap, make no abstraction.
4. **Component boundary:** keep wrappers thin; move product semantics upward if `components/ui` starts depending on product/service policy.
5. **Canonical gate integration:** this scanner runs as the gate's inventory layer; keep it there rather than adding a second entrypoint.

## Non-goals

- no visual identity redesign;
- no automatic dedupe by resolved value;
- no mass token deletion;
- no universal layout DSL;
- no shadcn fork;
- no assumption that a zero-consumer product state must become visible;
- no assumption that a contract or screenshot is upstream product truth.

## Maintenance

Run the inventory when changing tokens, `components/ui`, shared typography, reusable layout composition, or contracts. CI runs the integrity form through `just design-check` — the canonical gate — not through `web-lint`, which is ordinary Web lint and type-check.

When a zero-consumer item appears, ask:

> Is it intentionally reserved, genuinely obsolete, duplicated, or simply not wired into the approved UI yet?

Answer that at the canonical owner, then make the smallest follow-up change.

# Spatial Relationships / Content Rhythm (Web + App)

> Canonical design relationship contract for [#4045](https://github.com/BestNathan/nession/issues/4045). Upstream: [Visual Language](../visual-language.md) → [Composition](../composition.md) → [Tokens](tokens.md) and [Patterns](patterns.md). Consumer references: [ResourceDetail](patterns/resource-detail.md), [ConfigurationForm](patterns/configuration-form.md), [OperationSurface](patterns/operation-surface.md).

## Purpose and status

**Spacing is a relationship, not merely a legal number.** Two screens can both use canonical typography and spacing tokens and still differ in grouping, alignment, inset ownership and apparent icon/text separation. This contract names those relationships so Web and App share one visual grammar without forcing identical density.

**Status: approved normative design target, Phase 1 documentation only.** Existing production values quoted below are observed baselines, **not assertions that every consumer already conforms**. No token migration, runtime component restyle, browser acceptance or prototype rewrite is claimed by this document. Source modifications, formal measurable contracts and screenshots are follow-up work. The App Workspace [#3971](https://github.com/BestNathan/nession/issues/3971) and its prototype remain independently pending.

This is not a new token layer, generic React layout DSL, universal card treatment, or replacement for the host/semantic-recipe ownership established in [Composition §14](../composition.md#14-layout-ownership-and-shared-recipes-3194).

## 1. Three different kinds of space, with one owner per edge

| Property | Meaning | Responsible owner | Prefer | Avoid |
|---|---|---|---|---|
| **Padding / inset** | Container boundary to *its own* contents | The containing Host, Surface, Row, Form or reader recipe | One outer padding at the boundary; intentional full-bleed variant | Parent and child independently adding insets to repair each other |
| **Gap** | Relationship between siblings in the *same* flow | Closest semantic parent: Inline, Row, Section, Stack, ActionGroup or an existing content recipe | Parent `gap`, semantic alignment and wrap policy | Icon `margin-right`, title `margin-bottom`, duplicate child spacing |
| **Margin** | Exceptional relationship to an *outside* flow or document edge | Explicit owning layout/document renderer | Only when `gap` cannot express the relationship (e.g. prose or intentional one-off external offset) | Arbitrary feature-owned `mt-*`/`mb-*` to reconstruct a shared Section rhythm |

**One-owner-per-edge invariant:** a visible separation belongs to exactly one layout relationship. Do not sum a parent's gap and a child's matching margin, or add nested container padding to compensate for a missing canonical inset. Replacing a 0-gap full-bleed row list with prose requires an explicit variant/boundary; do not let `p-0` leak into ordinary body content. Negative margins are not a way to visually fix an icon-slot problem.

A component can still use local `flex`, `grid`, `min-w-0`, `flex-1` and overflow decisions inside its owned content. Promote a **stable, repeated relationship** to an existing shared recipe only after there are at least two independent consumers or concrete drift evidence. Do not wrap every `div` in `Inline`/`Stack`.

### Source of numbers versus source of relationships

- The **design/token graph**, emitted as `--nession-*` in [generated Web CSS](../../../design/generated/web.css), owns numeric Nession visual values; do not hand-edit generated CSS or create a second `--aw-*` namespace in production.
- The existing `--nession-shell-space-{1,2,3,4,5}` values currently resolve to **4, 8, 12, 16, 24 CSS px** on both Experiences. They are **available steps**, not proof that all compositions consume them.
- `--nession-panel-padding` currently resolves to **12px Web / 16px App**. Control/row/touch bands also differ; icon *paint* dimensions and hit-target dimensions are independent.
- shadcn/base-ui primitives may still use upstream utility geometry, e.g. Button `gap-1.5` (6px) and `px-2.5` (10px), as documented in [Components](components.md#which-upstream-geometry-gets-an-owner). These are **known upstream exceptions**, not a new global spacing step nor permission for capability-specific copies.
- A relationship can use different Web/App measures if its Experience density warrants it. Preserve named meaning and alignment/ownership first. Do **not** silently change approved Web spacing when refining App.

## 2. Relationship families and target baseline

Values in this table are **review targets**, not shipped computed-style assertions. Prefer the five existing 4/8/12/16/24px steps; ranges indicate an explicit semantic/context choice to be resolved at the recipe owner, **not caller-selectable arbitrary values**.

| Relationship | Web candidate | App candidate | Semantic owner / anatomy |
|---|---:|---:|---|
| Small status glyph ↔ short label | 4px | 4px | InlineStatus; align glyph to label's visual center |
| Bare icon ↔ button/menu text | 8px target; existing shadcn Button 6px | 8px target; current Button upstream 6px | Existing Button/Menu/Action recipe; retain upstream baseline until reviewed |
| Leading **resource icon slot** ↔ title/subtitle block | 8px | 12px | ResourceRow leading/content/trailing; slot size is separately declared |
| Primary row title ↔ supporting metadata (vertical) | 4px | 4px | RowTextStack; same text grouping |
| Header title ↔ subtitle/context (vertical) | 4px | 4px | Header/DetailHeader; supporting text cannot become a second primary |
| Section heading ↔ its owned content | 8px | 8px | DetailSection/FormSection/reader section; no title's own bottom margin |
| Section heading ↔ local action | 8px | 8px | SectionHeader; action aligns to far edge, does not push text offscreen |
| Text region ↔ trailing action cluster | 12px | 12px | Row/SectionHeader; `min-width:0` for text and preserved action hit area |
| Independent adjacent toolbar actions | 8px | 8px | ActionGroup; each button controls its own internal inset |
| Label ↔ field control / helper / error | Recipe-owned 4–8px | Recipe-owned 4–8px | FormField; input/help/error grouped without independent margins |
| Related form fields | 12px | 12px | FormSection/FormGrid; on App stack rather than compress fields |
| Read-only fact label ↔ value (inline) | 8px | 8px | DetailFact; baseline alignment, wrap value, preserve label readability |
| Related fact units | 12px | 12px | DetailFacts; continuous information is not a card grid |
| Ordinary contained content inset | 12px baseline | 16px baseline | Surface/section host; full-bleed and editor are named variants |
| Neighboring distinct regions | 16px baseline | 16px baseline | Parent ContentStack; no child `margin-bottom` duplication |
| Separate major Sections | 24px baseline | 24px baseline | Parent SectionStack; allow documented dense Web variant only when justified |
| Prose paragraph ↔ next paragraph | 12px candidate | 12px candidate | Reader/Markdown adapter, **not** generic shell CSS |
| Prose ↔ code/tool/result block | 16px candidate | 16px candidate | Reader/Conversation recipe; preserve independent renderer formatting |
| Rows of the **same** continuous list | **0 outer gap** | **0 outer gap** | Collection; row padding/height/divider define rhythm |
| Adjacent **different** row groups | 16–24px via group parent | 16–24px via group parent | Collection/Section owner; never per-row margin |

**Why a candidate matrix?** Existing `DetailSurface` / `FormSurface` use `gap-5` (20px), `DetailSection` uses `gap-2` (8px), `FormSection` uses `gap-3` (12px), and `FormField` uses `gap-1.5` (6px). Their semantic relationships are already partly centralized in production. This specification describes where convergence should be decided, **not** a false claim that 24px sections or 8px Button icon gaps have already shipped. Existing 20px/6px choices remain until an owned consumer migration and browser review approve a different metric.

## 3. Same-line mixed elements: slot, text, action

The canonical resource row anatomy is:

```text
Row boundary [padding-inline]
  Leading icon slot | gap | Content (title / metadata) | gap | Trailing action
  [painted glyph inside slot]        [min-width: 0]              [hit target]
```

**Do not equate the CSS gap with the perceived icon-to-text gap.** For example, a centered 18px glyph inside a 36px visual slot has 9px of blank space on either side. A 12px gap between the **slot's border box** and the text therefore leaves approximately **21px between the painted glyph edge and text** (9 + 12), before accounting for SVG path whitespace and font side bearings. These are geometry examples, not universal production slot values.

For each repeated icon/text relationship, explicitly state:

1. **Visual glyph** size, icon slot box size, slot-background/shape and whether it is interactive.
2. **Hit target** independent from glyph size (App icon-only actions retain their supported touch floor; a decorative leading glyph does not automatically become a button).
3. **Alignment**: icon/slot center with one-line text, or alignment to the intended block center/first line in multi-line rows; a two-line stack's internal 4px rhythm belongs to that stack.
4. **Sizing**: text gets `min-w-0` with chosen truncation/wrap; trailing actions are `shrink-0` and stay available. Use `justify-between` / an automatic start margin for trailing alignment only when the row owner declares it.
5. **Content and icon**: the semantic row owns `gap`. Its child glyph or title never supplies a compensating `margin-right` / `margin-left`.

Never solve apparent painted-icon distance with a hidden negative margin while ignoring the icon slot. Revisit the slot itself and assess perceptual distance in Chromium.

### Inline glyph/text versus resource row

A button's glyph/text is a **compact inline action**; a resource row's glyph/text is a **composite item with an icon slot**. They do not share the same required box geometry. Small status glyphs, buttons, two-line resource rows and icon-only controls must each have their own named relationship owner, even if some resolved gaps happen to match.

## 4. Vertical rhythm depends on content semantics

- **Header**: identity/title and quiet metadata are one group; avoid a second independent header inside a nested capability.
- **Section**: section heading + local action + its contents form one relation; parent Sections own the separation between peer Sections.
- **Collections**: neighboring rows in one group stay contiguous; use row min-height, internal padding, state surface and optional dividers. Start a new group with parent Section spacing, not per-row cards.
- **Facts**: read-only label/value blocks remain read-only; do not style each as an input field just to draw separation.
- **Configuration**: FormSection/FormField own label, control, helper and validation rhythm. Errors belong near their field; grouped actions belong to the operation's action line.
- **Reader / conversation**: a paragraph, embedded tool result and code block are different content kinds. Reader-specific prose rhythm governs the boundary between them, including collapsed/expanded and long output states; ordinary shell Stack spacing is not injected into the renderer's internal DOM.
- **Empty / error**: preserve the section's outer inset and one readable flow between icon, title, description and recovery action; don't leave ghost padding from missing rows.
- **Full-bleed**: Terminal, code editors, diff lines, virtualized rows and purpose-built continuous lists can validly have no external gap or local padding. Their adapter owns internal text/inset/line geometry. Do not apply regular Surface padding inside xterm, CodeMirror, raw JSON or terminal glyph grids.

The priority from [Visual Language P7](../visual-language.md#p7--spacing-and-hierarchy-before-containers) remains: **whitespace → background relationship → border → radius → elevation**. Additional cards are not a substitute for missing rhythm.

## 5. Who consumes what

| Layer | Allowed ownership | Not allowed |
|---|---|---|
| Experience Host (`WebLayout`, `AppLayout`, `WorkspacePanel`) | Screen/frame safe-area/scroll ancestry; work-region outer inset and hosted top/bottom chrome | Reimplement domain-specific nested form/row spacing |
| Semantic Recipe (`ResourceDetail`, `ConfigurationForm`, `OperationSurface`, existing row/menu patterns) | Stable Section/Row/Inline/Stack relationships and named inset variants; typography/material role | Own a second page header, second global scroller or feature-specific values |
| Capability local content | Truly unique internal grid/flow, semantic choice between recipes, specialized editor/reader adapter | Rewrite an existing Row/Form/Surface recipe using arbitrary gaps/margins |
| Tokens / Experience | Canonical spacing measures and experience-specific density/target/icon sizes | Encode `Section → next Section` or `icon → label` rules as a new independent design system |
| Third-party renderer adapter | Markdown prose, terminal lines, CodeMirror text layout | Leak renderer rules into Web/App product chrome |

Current production reference points:
- [`web/src/components/ui/resource-detail.tsx`](../../../web/src/components/ui/resource-detail.tsx) owns Section/Fact/Group, including title versus label/value roles.
- [`web/src/components/ui/configuration-form.tsx`](../../../web/src/components/ui/configuration-form.tsx) owns FormSection/Field/Grid/Actions.
- [`web/src/components/ui/operation-surface.tsx`](../../../web/src/components/ui/operation-surface.tsx) owns lead/error/action grammar.
- [`web/src/components/ui/button.tsx`](../../../web/src/components/ui/button.tsx) and [`label.tsx`](../../../web/src/components/ui/label.tsx) retain documented upstream primitive geometry.
- [`web/src/app/workspace/layout/workspaceLayout.tsx`](../../../web/src/app/workspace/layout/workspaceLayout.tsx) owns Workspace page-level scroll/master-detail geometry. It is **not** a new universal content rhythm provider.
- [`design/scripts/layout-ownership.mjs`](../../../design/scripts/layout-ownership.mjs) currently checks host/scroll/recipe ownership and narrow raw spacing violations. It **does not yet** enforce the entire relationship matrix.

## 6. Anti-patterns and repair

| Invalid composition | Why it fails | Required repair |
|---|---|---|
| Parent `gap-4` + next child `mt-4` | Two owners create accidental 32px separation | Parent SectionStack alone owns the peer-region gap |
| `<Icon className="mr-3" />` repeated in every capability | Icon/text pairing drifts and wrapping changes alignment | Shared Row/Inline owner supplies gap; icon slot is measured separately |
| `p-0` reused for list, description and dialog body | Full-bleed exception removes prose insets | Name full-bleed list/reader/editor variant; keep ordinary content inset |
| Each file row wrapped in a new bordered card | Grouping depends on decoration, density explodes | Continuous rows share one Collection; distinct groups get Section rhythm |
| `text-xs` + `mb-1` locally patching the same form label | Both typography and field relation drift | FormField/Label own role and adjacent control gap |
| Negative margin on a 36px slot to make 18px glyph look closer | Hides perceptual-space problem in one screen, breaks another | Measure slot-to-text and glyph-to-text; choose approved slot/row anatomy |
| Generic `* + * { margin-top: ... }` for all capability bodies | Breaks code lines, virtualized lists and nested local gaps | Named Section/Reader/Collection parent relationships, with valid zero-gap modes |
| Different local padding on Project vs Sandbox facts | Same semantic recipe renders differently | Reuse DetailFacts/DetailFact; divergence needs explicit semantic variant |

## 7. Implementation and verification sequence

**Phase 1 — this document-only change:** Publish this canonical relation/ownership specification and link to it from the existing design index, visual language, patterns, composition and validation. Do not restyle or change output values; keep #4045 Acceptance pending until verified source evidence.

**Phase 2 — measured consumers:** Inventory ResourceDetail/ConfigurationForm/OperationSurface, menu/button/label and the App #3971 candidate. Promote *only proven repeated differences* into a shared existing recipe or small meaningful variant. Confirm every affected owner, padding boundary, drawn glyph/slot/target geometry and its Web/App density. Avoid a speculative `Stack`/`Inline`/`Surface` mega-API.

**Phase 3 — executable proof:** Reuse canonical Design Gate and browser Design catalog. Add representative deterministic negative fixtures for repeated margins/host overrides only where a stable rule is machine-decidable; do not flag all local numeric `gap-*` as invalid. Compare computed roles and **actual bounding-box relationships** between independent consumers (e.g. Project vs Sandbox detail, Project vs Sandbox form) in Web 1440/1180/1024 and App 375/390/430 plus landscape as relevant. Check long labels, text wrapping, icon ink/slot/hit target, Section separation, dense lists, empty/error states and reader/editor/Terminal exemptions. **Browser acceptance is Chromium + Playwright with source-aligned Case proof**, never a mock screenshot or plain document claim.

### Boundary and references

This document owns **spatial semantics**; [tokens.md](tokens.md) owns numerical token values, [composition.md](../composition.md) owns overall page/scroll geometry, [patterns.md](patterns.md) and their specific specs own component anatomy, and [validation.md](validation.md) owns evidence strategy. A changed product decision is made here and then projected into the relevant narrow component and executable contract, without cloning this whole matrix into those documents.

Related requirements: [#760](https://github.com/BestNathan/nession/issues/760) (inventory), [#1216](https://github.com/BestNathan/nession/issues/1216) (typography roles), [#3137](https://github.com/BestNathan/nession/issues/3137) (content recipes), [#3194](https://github.com/BestNathan/nession/issues/3194) (layout ownership), [#3971](https://github.com/BestNathan/nession/issues/3971) (App consumer).

# Design Tokens (architecture)

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [product model](../product-model.md) → [visual language](../visual-language.md)

Executable tokens, codegen, and lint live in [#467](https://github.com/BestNathan/nession/issues/467). This document records the **vocabulary and layering constraints** so executable styling follows product meaning instead of freezing accidental shell structure.

## What tokens do — and do not do

Tokens encode reusable visual/state values. They do **not** define information architecture or decide capability presence.

`Sessions ← Terminal → Workspace`, contextual capability emergence, or whether a control is visible are product/interaction rules. They belong in product model, IA, interaction, pattern, and contract layers — not in color/spacing token names.

## Layer stack

There are **two axes**, not one ladder. Reading Experience as "the layer under
Domain" is the misreading this diagram used to invite: it makes every Web-only
number look like it belongs to Experience, and Experience then absorbs
pattern metrics until it means "CSS values for the browser".

```text
Meaning axis                    Platform axis
Primitive                       Primitive / Semantic
    ↓                                ↓
Semantic                        Experience (Web / App)
    ↓
Domain

Pattern consumes the relevant meaning + the relevant platform vocabulary.
```

Domain answers **what a thing is**. Experience answers **how a platform
expresses it** — density, touch/pointer behavior, safe areas, control sizing.

So a value is not Experience-owned merely because it differs per platform or
because only one platform consumes it. `experience.web.workspace.treeWidth` is
a *file-workspace* decision that happens to be expressed on Web; calling it
"Experience" would be true of its housing and false of its owner.

### When a value's owner is narrower than Experience

A value whose meaning belongs to one pattern or composition says so, in the
token source, with the same `$`-annotation convention as `$description`:

```json
"composer": {
  "$owner": "pattern.terminal-capsule",
  "fontSize": { "ref": "primitive.typography.size" }
}
```

`$owner` inherits down its group, so it is stated once per family or, when a
family is genuinely mixed, on the individual leaf. **An absent `$owner` means
generic platform vocabulary**, not "unknown" — that is the default, and most of
`control` / `icon` / `focus` / `motion` is exactly that.

The annotation is deliberately inert: it changes no generated artifact, adds no
token layer, and no consumer reads it. Its job is to make ownership *legible and
checkable* — the inventory reports it as evidence, and `$owner` must name a real
`patterns/*.md` doc, so a typo fails rather than reading as a decision. Using a
pattern that has no doc yet is the signal to write the doc, not to skip the
annotation.

Do not add a pass-through `PatternToken` layer to express this. The value stays
where it is; only its ownership is recorded.

### The current families, classified

Read from production consumers, not from the values. Counts are Web leaves
(`experience/app.json` mirrors the same families).

| Family | Leaves | Owner | Evidence |
|---|---|---|---|
| `composer` | 45 | `pattern.terminal-capsule` | every consumer is under `product/terminal/capsule/` |
| `workspace` | 13 | `pattern.file-workspace` | tree + editor metrics; consumers are the explorer renderers and the file viewer/editor |
| `terminal` | 4 | `pattern.terminal-surface` | the xterm surface's own type and inset. `padX` / `padY` are consumed as CSS by `product/terminal/components/TerminalViewport.tsx`; `fontSize` / `lineHeight` reach xterm as JS options through `design/generated/terminal.ts`, so the inventory's lexical consumer scan classifies them `reserved` even though they are wired — the scan reads `web/src` for `--var` and utility spellings, and this channel has neither |
| `shell.sessionRowPadY` / `TitleFontSize` / `MetaFontSize` | 3 | `pattern.session-item` | consumed only by `features/sessions/components/SessionItem.tsx` |
| `shell` (the rest) | 18 | **shell composition** | the shell's own chrome. `shell.space-*` is generic spacing; `shell.railWidth` / `foot*` size the shell, which is the composition root rather than a pattern — no `$owner`, and none is warranted |
| `control`, `icon`, `focus`, `motion` | 10 | **generic platform** | consumers span `app/`, `app/workspace/`, `app/patterns/` and the capsule, which is what "generic" means here |
| `row` | 3 | generic platform | zero consumers, already classified `reserved` |

`shell.sessionRowRadius` is deliberately **not** annotated: it is genuinely
shared (session rows, agent nodes, and file rows all consume it), so it is not a
session-item metric that happens to be reused. Its name is narrower than its
use, which is a naming question for whoever next touches those rows — not an
ownership one, and not a reason to move a value.

### Typography roles

[visual-language.md](../visual-language.md) defines five chrome text roles. Until
#774 they existed only as prose: the token layer named sizes per component
(`sessionRowTitleFontSize`, `nodeFontSize`, `footFontSize`, …), so the same job
had a different name everywhere it appeared.

`experience.web.typography.{primary,secondary,metadata,code}.size` is that
vocabulary in the token layer. A component token says which role it is and
derives the size from it:

```json
"sessionRowTitleFontSize": { "ref": "experience.web.typography.primary.size" }
```

**A role owns size only.** Family and weight are cross-cutting — `font-medium`
appears under every role, and monospace carries both metadata
(`sessionRowMetaFontSize`) and primary (`nodeFontSize`) — so folding them into a
role would misstate the evidence. Line-height stays with the block that owns it
(`workspace.treeLineHeight`), not with the size role.

Because a role's consumers are reached through the ref graph, the inventory
reports them (`downstream` + `effectiveConsumers`) rather than anyone grepping
for `--typography-*`. A role that reaches no production file fails a test — the
requirement's own failure mode is "new semantic roles that nothing consumes".

The pilot migration moved five tokens onto roles and **changed no value**:
`design/generated/web.css` gained four role variables and no existing variable
moved. `|value|` in the token source is now stated once per role instead of once
per component.

#### Near-duplicates this surfaced and deliberately did *not* collapse

Three tokens do a role's job at a different size. Converging them is a visual
decision, not a token one, so they were left where they are:

| Token | Value | Role value | Why it is not obviously the role |
|---|---|---|---|
| `shell.footFontSize` | 10.5px | 10px | its own description says "matching the session metadata it sits under" — the stated intent and the value already disagree |
| `shell.nodeFontSize` | 11.5px | 12.5px | monospace; "a node name is infrastructure identity" may earn its own role |
| `workspace.editorHeadFontSize` | 11.5px | 10px | "it names what is open, it is not a title" — reads as metadata |

These three are the evidence that the fragmentation was real. Separately, 20
font sizes in production are still raw literals — `text-[10px]` (15),
`text-[11px]` (3), `text-[9px]` (2), across seven files — and those bypass the
token layer entirely. They are the next migration, not this one.

Product UI must not consume Primitive palette values directly.

Web and App share Primitive, Semantic, and Domain meaning. They specialize at Experience for density, touch/pointer behavior, safe areas, and control sizing. Do not create two independent design systems.

## Core Domain vocabulary

Current shared vocabulary follows [product-model.md](../product-model.md) and keeps independent state dimensions separate.

```text
agent.online
agent.connecting
agent.reconnecting
agent.offline
agent.error

session.active
session.exited
session.unknown

attachment.attached
attachment.attaching
attachment.detached
attachment.failed

location.local
location.remote
action

terminal.background
terminal.foreground
terminal.selection
terminal.cursor

workspace.background
workspace.surface
workspace.navigation

file.selected
file.modified
file.created
file.deleted

editor.background
editor.gutter
editor.activeLine
```

The `agent.*` family reflects today's Agent-backed infrastructure implementation. The product model already allows Workspace Locations and future providers, so code must not interpret `agent.*` as proof that Agent is the permanent top-level product object.

If broader location/provider state becomes independently user-visible, add deliberate Domain semantics rather than overloading unrelated tokens.

## Capability and extension tokens

Nession's core token vocabulary should remain workload-agnostic, but extensions may need domain-specific state.

The rule is:

> Extension-specific tokens may describe a capability's own semantic state, but they must not redefine Nession's global hierarchy, navigation, or visual language.

For example, a Claude Code extension may eventually need semantic state for a running task or conversation. That should be scoped as extension/capability semantics and map back through shared Semantic values. It should not make universal core tokens such as `session.thinking` or force every Session into an AI-chat model.

Avoid universal AI-runtime semantics unless Nession itself truly owns them across workloads.

## Contextual presence is not a token state machine

The product capability lifecycle is:

```text
unavailable -> available -> relevant -> active
```

That vocabulary guides presence and interaction. It should not automatically become four colors.

In particular:

- `available` is usually visually quiet;
- `relevant` may change presence before color;
- `active` does not imply accent saturation;
- absence/visibility is generally a composition or contract concern, not a palette concern.

This prevents the design system from turning every capability state into decorative badges.

## Constraints for executable tokens

- Agent/location connectivity, Session lifecycle, and client attachment must not collapse into one generic status.
- Light/dark themes resolve Semantic tokens to Primitive values; product UI consumes Semantic / Domain / Experience.
- Product patterns and extension views should prefer shared Semantic meaning before adding new Domain vocabulary.
- Do not create token names for one-off layout decisions simply to avoid writing composition rules.
- `location.*` and `action` ref the theme-scoped Primitive directly (`primitive.{theme}.…`) rather than routing through a pass-through Semantic alias. A pass-through would emit `--location-local: var(--location-local)` — a self-reference that computes to nothing. The `{theme}` placeholder is what keeps a Domain leaf theme-resolvable when no Semantic role sits between it and the Primitive.
- There is no `success` and no `info`. Healthy is neutral (visual-language.md P6) and informational text uses `muted-foreground`; see [visual-language.md](../visual-language.md) § Where the values come from. Adding either back is a product decision, not a palette tweak.
- Do not encode permanent-navigation assumptions in tokens (`workspace.toolTab.active`, `agentSidebar.width`, etc.) unless the underlying product relationship is truly stable and canonical.
- CSS is an output/consumer, not the product source of truth. App may not consume CSS at all.

Example legal chain:

```text
color.green.500
      ↓
success
      ↓
agent.online
      ↓
AgentContext / connectivity detail
```

Never:

```text
color.green.500 -> product component
```

And avoid treating the chain above as a requirement to visibly render `agent.online`; healthy state may be intentionally absent under the product Principles.

## Experience vs product structure

| Belongs in tokens | Belongs in higher-level design |
|-------------------|--------------------------------|
| `agent.online` color mapping | Whether healthy Agent context is visible at all |
| `experience.web.control.md` | Whether Web uses a switcher, menu, overlay, or contextual entry |
| `experience.app.touchTarget.min` | `Sessions ← Terminal → Workspace` interaction model |
| `workspace.surface` | What Workspace shows in the current context |
| composer spacing / radius | Whether a capability earns capsule presence |

Tokens make an approved composition consistent; they do not approve the composition.

### The two experiences are asymmetric

`emitAppExperienceRemap` writes **every** app leaf into `[data-experience="app"]`,
while web leaves are written to `:root`. The two sets are therefore not mirror
images:

- a token **only App** defines (`experience.app.touchTarget.min`,
  `experience.app.composer.shellInset`, …) resolves to **nothing** outside the App
  experience — the declaration is dropped and the layout collapses silently;
- a token **only Web** defines (`experience.web.shell.*`, `experience.web.workspace.*`)
  sits at `:root` and therefore resolves in **both** experiences;
- a **shared** token (`experience.*.control.md`) is emitted at `:root` and
  overridden in the app block, so it is safe in either.

So "Web code used an App token" is a real defect and the mirror is not. Because
this is invisible at runtime, `nession/no-cross-experience-token` enforces it
statically: an App-only custom property may only be referenced from a class
binding whose name marks it App-scoped (`capsuleShellAppOuterClass` beside
`capsuleShellWebOuterClass`). Whether an element renders on Web is a runtime
property of the component tree; the binding name is the author's statement of it,
and it is the only part a static check can read.

## Source of truth

```text
design/tokens/          platform-neutral token source
design/generated/       derived CSS / TS / lint metadata — never hand-edit
design/contracts/       measurable UI contracts; see [contracts.md](contracts.md)
docs/design/            product/IA/interaction/pattern/validation architecture
```

Precedence remains:

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
executable tokens / contracts
    ↓
implementation
```

When an old executable token or contract encodes a superseded product assumption, update the lower layer; do not weaken the upstream product model to preserve generated output.

# Visual Language

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product-model.md](product-model.md) → [information-architecture.md](information-architecture.md) → [interaction](interaction/)

This document defines how Nession makes hierarchy visible: what dominates, what recedes, how state gains emphasis, and how a minimal interface still feels refined rather than unfinished.

It owns visual hierarchy and relative treatment. Exact values live in [design-system/tokens.md](design-system/tokens.md), layout relationships in [composition.md](composition.md), and measurable rules in [design-system/contracts.md](design-system/contracts.md).

## The Nession signal

> **Work dominates. Chrome recedes. Capabilities earn presence. Healthy infrastructure stays quiet. Precision creates quality.**

For the current Session-first experience, Terminal is the dominant live work surface. That does not mean every future Nession surface must look like terminal chrome; it means the current work always receives the strongest visual weight.

Nession should feel calm and deliberate even when the system behind it is distributed and capable. The interface should absorb complexity rather than advertise it.

## Product visual principles

### P1 — Current work dominates

The active work surface receives the strongest visual weight and the majority of usable space.

When Terminal is active, nothing in surrounding chrome should compete with terminal output. When the user explicitly opens Workspace or a deeper capability surface, the new context may become locally dominant while preserving Session continuity.

### P2 — Chrome recedes

Navigation, headers, infrastructure metadata, and switching controls exist to support work. They should be restrained in contrast, size, and persistence.

A control that can be reached on demand does not need to remain permanently visible.

### P3 — Capabilities earn presence from context

Do not visually advertise every available extension.

Capability presence should track product state:

```text
unavailable -> available -> relevant -> active
```

Routine availability is quiet. Relevance can create a contextual affordance. Activity can create lightweight presence. Full capability UI is explicitly opened.

### P4 — Progressive disclosure is visible hierarchy

The first layer communicates only what is needed now. Secondary state, commands, configuration, history, and advanced controls appear at deeper interaction levels.

Visual density must not become a substitute for discoverability.

### P5 — One dominant action per region

A region should have one clear primary intent. Other actions remain secondary, ghost, contextual, or hidden until requested.

The TerminalCapsule, for example, should read first as one input surface rather than as a row of equally important buttons.

### P6 — Healthy is quiet; degraded gains emphasis

Healthy infrastructure is identity/context, not an achievement badge.

Agent/location reconnecting, attachment failure, Session exit, and other states that threaten continuity may gain prominence. The rest of the interface should not become louder with them.

### P7 — Spacing and hierarchy before containers

Group related information with whitespace, alignment, typography, and background relationship before adding borders, cards, or shadows.

Use the weakest separation cue that works:

```text
whitespace -> background shift -> border -> radius -> elevation
```

Floating controls and overlays may use elevation because their spatial role requires it.

### P8 — Color communicates state or action

Color should communicate selection, action, or state. It should not decorate generic chrome or give every extension a competing brand identity.

Capability-specific branding may appear as subtle identity where useful, but the surrounding control language remains Nession's.

### P9 — Precision creates the premium feeling

Minimal does not mean primitive.

Quality comes from exact spacing, alignment, typography, stable geometry, focus behavior, motion timing, state transitions, touch/pointer targets, and consistent feedback.

A quiet component with excellent details is preferable to a visually busy component trying to signal sophistication.

### P10 — Empty space is intentional

Unused space belongs to the work, not to decoration or expanding chrome. On larger screens, extra space should generally increase breathing room or work-surface capacity rather than widen navigation.

### Empty states

An empty screen is an invitation to act, not a status report. "No sessions" describes the absence and stops; the user still has to work out what to do about it.

- Say what the user can do, in the interface's voice — not a person's.
- Reuse the action's own name, so the word on the empty screen is the word on the control. Session creation is called **New Session** everywhere.
- Sentence case, active voice, no apology, no vagueness.
- A *search* that found nothing is a different case: it reports what happened ("No sessions match your search") rather than inviting an action, because the action is to change the query.

## Where the values come from

P1–P10 say what should dominate and what should recede. They do not say which grey. This section is the bridge: the intent above, resolved into the values in [`design/tokens/`](../../design/tokens/) — primitive palette, terminal ANSI, radii.

Two rules generate the palette:

1. **Location is the only chromatic axis.** Everything else is neutral. Local sessions are *colourless*: a user working only on their own machine sees no accent colour at all, because the boundary has not been crossed. `location.local` (warm, hue 55) and `location.remote` (cool, hue 255) share chroma and sit within the JND of each other in lightness, so neither location outranks the other. This implements [workspace.md](workspace.md)'s "making the active or affected location clear only when that distinction matters".
2. **Colour appears only where P8 licenses it** — state or action — and the neutral ramp carries everything else. It is built to be whisper-quiet near the ground and then jump hard to text, so separation comes from a background shift rather than a border (P2, P7).

Measured against both grounds a foreground can sit on. The `Value` column is a
reading of [`design/tokens/primitive.json`](../../design/tokens/primitive.json),
not a second source of it: the file stores oklch, and both the hex and the ratio
here are produced from it by the same conversion
[`token-contrast.test.mjs`](../../design/scripts/token-contrast.test.mjs) uses to
solve them — so when this table and the test disagree, the test is right and the
table is stale:

| Token | Value | on canvas `#FFFFFF` | on chrome `#F6F8FA` |
|-------|-------|--------------------|---------------------|
| `neutral.ground` | `#FFFFFF` | — | 1.06:1 |
| `neutral.surface` | `#F6F8FA` | 1.06:1 | — |
| `neutral.fill` | `#EFEFEE` | 1.15:1 | 1.08:1 |
| `neutral.line` | `#E7E7E5` | 1.24:1 | 1.16:1 |
| `neutral.line-strong` | `#D8D8D5` | 1.43:1 | 1.34:1 |
| `neutral.text-disabled` | `#8C8F94` | 3.26:1 | 3.06:1 |
| `neutral.text-muted` | `#6F737A` | 4.79:1 | 4.50:1 |
| `neutral.text-secondary` | `#55575D` | 7.22:1 | 6.78:1 |
| `neutral.text-primary` | `#232528` | 15.37:1 | 14.44:1 |
| `location.local` | `#AE5D17` | 4.79:1 | 4.50:1 |
| `location.remote` | `#3974BC` | 4.79:1 | 4.50:1 |
| `action` | `#008450` | 4.79:1 | 4.50:1 |
| `state.danger` | `#D0383A` | 4.87:1 | 4.57:1 |
| `state.warning` | `#956900` | 4.87:1 | 4.57:1 |

The four accents sit at exactly 4.50:1 on the chrome because that is how they
were solved: hue and chroma held at the mockup's values, lightness taken to the
minimum step that clears AA on `surface` rather than on `ground`. A reader who
finds them "about 4.5" has read the table correctly — the numbers are the
constraint, not a coincidence.

**The chrome is the binding constraint, not the canvas.** It is the darker ground, so a colour that clears AA on white can still fail on the sidebar — which is where most metadata text actually lives. Every value above is solved against both. `text-disabled` takes the 3:1 floor of a perceivable UI boundary; WCAG 1.4.3 exempts inactive controls from the AA text requirement, and it is not a licence to make them invisible.

**`success` is not a colour.** Healthy infrastructure is identity/context, not an achievement badge (P6). `agent.online`, `attachment.attached` and connection-reachable states are neutral: they are the steady state, and the steady state does not get to be loud. `state.danger` and `state.warning` exist because they threaten continuity.

**`action` is the colour of acting** — the result of a deliberate user action (`file.created`), and an action affordance such as a link. Its hue is derived rather than picked: 158 is the midpoint of the short arc between the two location hues (55 → 255), so the colour of acting is literally the colour of crossing over.

**Colour is never the only carrier.** Location must always appear with its name or a named icon, never as a bare swatch (WCAG 1.4.1).

### The terminal

The terminal sits on the same ground as the chrome. `composition.md` §4 and this document both say *Terminal is not a card* — and a dark rectangle set into a light page is exactly a card, so the terminal's background is the canvas, by construction rather than by convention. Its ANSI set is Nession's own, in [`design/tokens/primitive.json`](../../design/tokens/primitive.json) under `terminal`, emitted as `design/generated/terminal.ts` because xterm takes an object rather than CSS.

Two properties of that set are deliberate and must not be "fixed":

- **`white` and `brightWhite` do not clear AA as text.** They are reverse-video *background* slots. In a light terminal the foreground role is carried by `foreground`; darkening them to satisfy a text check would break reverse video.
- **`minimumContrastRatio` is 4.5.** Identity never repaints terminal output — ANSI red/green/yellow are semantic to the user's own commands and to `ls --color` — but a light ground makes the light end of the 256-colour cube unreadable, and that cube is not ours to change. xterm adjusts a foreground that fails the ratio; this is a deliberate trade of palette exactness for reachability.

### Enforcement

These are not prose promises. `design/scripts/token-contrast.test.mjs` computes every pair above from the token source and fails the build below AA; `design/scripts/no-inherited-palette.test.mjs` fails if a chroma-free grey ramp or a foreign palette name reappears in the token source, or if Catppuccin survives anywhere in `web/src`. Both run under `just design-test` in CI.

## Typography hierarchy

Typography roles are semantic and relative.

| Role | Visual intent | Typical use |
|------|---------------|-------------|
| Page title | The surface's own name | active Session, Workspace capability, pushed detail title |
| Work / local primary | Highest within region | Session name, active file, current capability title, focused input |
| Body / control | Ordinary reading size for actions | buttons, menu items, filters |
| Secondary | Supporting but fully readable | supporting labels, secondary actions, infrastructure rows |
| Metadata | Quiet | Agent/location, recency, status details |
| Caption | Lowest readable hierarchy | helper text, keyboard hints |
| Code / terminal / mono | Workload-specific | terminal text, paths, commands, code |

Rules:

- one region should not contain multiple competing primary text roles;
- metadata never outweighs the thing it describes;
- monospace communicates code/terminal identity, not decoration;
- Web and App share semantic roles while Experience tokens may change sizes/hit areas;
- the first four roles are stated in the token layer as `typography.{primary,secondary,metadata,code}` (see [tokens.md](design-system/tokens.md#typography-roles)) — a role names the text's job, so use the role rather than a component-local size;
- the scale is per Experience, not per component, and each Experience states its own sizes: `experience.web.typography` carries the roles Web consumes, `experience.app.typography` carries the App's (#1073). A role is *not* a promise that both Experiences resolve it to one number — it is a promise that both are naming the same job;
- `pageTitle` and `body` have no Web leaf today because the Web shell renders no page header and has no App-style control set; an Experience may state a role the other does not consume, but neither may invent a size in a component instead;
- controls take the body/control role rather than a size inherited from the primitive that rendered them, so a secondary action does not silently become a smaller text level;
- terminal glyph rendering remains owned by the terminal surface rather than chrome typography, and document typography belongs to the document.

## Surface hierarchy

| Surface | Role | Default treatment |
|---------|------|-------------------|
| App/Web canvas | Base product ground | quiet, minimal separation |
| Active work surface | Terminal/current work | maximum usable area; Terminal is flush and borderless |
| Workspace context | contextual depth | subtle surface relationship; content-driven |
| Floating interaction | TerminalCapsule/contextual control | contained surface with restrained elevation |
| Capability overlay/panel | explicitly requested depth | elevated or layered, without redefining global shell |
| Popover/dialog | temporary action/detail | contained + elevated |
| Warning/error | continuity-threatening state | local state emphasis, not global decorative alarm |

Rules:

- Terminal is not a card.
- Do not stack background + border + shadow + accent for one selection.
- Persistent healthy chrome should not use elevation.
- Extension content may be visually distinct inside its own detail view, but global chrome remains coherent.

## Density hierarchy

Density follows the work being performed, not a single app-wide preference.

| Context | Density intent |
|---------|----------------|
| Terminal | dense work content |
| Workspace resource tools | dense where information-rich |
| Session navigation | comfortable and scannable |
| Forms / configuration | relaxed enough for comprehension |
| Metadata | compact |
| TerminalCapsule | compact at rest, expands only when input/context requires |
| App touch controls | adequate touch-target density |

Chrome should yield before the work surface yields.

## State-driven emphasis

Emphasize what changes the user's ability to continue working.

Examples:

| Condition | Default visual response |
|-----------|-------------------------|
| Agent/location healthy | quiet identity/context |
| reconnecting | local medium emphasis |
| offline/error | local high emphasis where reachability matters |
| Session exited | Session identity/state changes clearly |
| attachment failed | local actionable emphasis |
| capability available | quiet / discoverable only when useful |
| capability relevant | contextual affordance may appear |
| capability active | lightweight presence; deeper UI only on request |

## Contextual interaction surfaces

The TerminalCapsule is the primary example of a control that should feel sophisticated without becoming busy.

Its resting state should have a stable silhouette and few visible controls. `+`, shortcuts, capability identity, or secondary actions should appear progressively. When a capability becomes active, Nession can acknowledge it with precise, lightweight presence rather than immediately opening a large panel — as of #748 that acknowledgement is carried inside the `+` expansion rather than on the resting capsule.

**Several floating surfaces may coexist, and they must read as one group.** The
anti-pattern list below warns against "multiple floating controls competing with
the TerminalCapsule", and the answer is not to keep the count at one — the shell
now also floats a surface switcher, a `+` expansion, a Workspace dock and an App
band. The answer is that **every floating surface takes the same treatment**: no
decorative border, and one elevation language — a 1px shadow ring plus two shadow
layers, carried for Nession's own floating surfaces by the `elevation-floating`
token. The underlying popover/dialog primitives already use the same *shape*
(a ring plus a layered shadow, no border) with their own literals, so the two
families read alike; they differ in value, not in language. Surfaces that share a
height language read as layers of one system; surfaces that each invent their own
shadow read as rivals. Adding a
floating surface therefore means adopting the shared treatment, not designing a
new one — and a floating surface that needs a *different* height to make sense is
evidence that it should not be floating.

Workspace follows the same rule at a broader depth: rich capability does not justify a rich permanent navigation bar.

## Motion

Motion communicates spatial relationship, state transition, and continuity.

Use it to clarify:

- Session/Workspace spatial transitions;
- capability presence appearing/disappearing;
- capsule expansion;
- overlay/panel depth;
- reconnect/recovery state change.

Motion should be subtle and interruptible. Routine actions do not need celebratory animation.

## Anti-patterns

- feature grids or tab bars used mainly to advertise capability;
- one accent color per extension in global chrome;
- multiple primary actions in one small control region;
- disabled permanent entries for unavailable capabilities;
- excessive cards, borders, shadows, or gradients used to manufacture "premium" appearance;
- infrastructure metadata visually competing with the work;
- permanent stacked chrome that reduces Terminal space;
- preserving an old approved screenshot when it now contradicts Vision or Principles.

## Enforcement

Use this document as qualitative visual guidance. Measurable pieces should be expressed through tokens/contracts/validation only after the product relationship is stable.

Canonical screenshots and regression tests protect an approved implementation from accidental drift; they do **not** outrank [`VISION.md`](../../VISION.md) or [`PRINCIPLE.md`](../../PRINCIPLE.md). When the product model changes intentionally, update the screenshot/contract baseline rather than treating an old baseline as immutable product truth.

## Ownership boundaries

- product direction → [`VISION.md`](../../VISION.md)
- product decision rules → [`PRINCIPLE.md`](../../PRINCIPLE.md)
- product concepts → [product-model.md](product-model.md)
- IA → [information-architecture.md](information-architecture.md)
- interaction → [interaction/](interaction/)
- Workspace semantics → [workspace.md](workspace.md)
- page geometry → [composition.md](composition.md)
- values → [design-system/tokens.md](design-system/tokens.md)
- measurable layout rules → [design-system/contracts.md](design-system/contracts.md)
- component/pattern internals → [design-system/patterns.md](design-system/patterns.md)

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

## Typography hierarchy

Typography roles are semantic and relative.

| Role | Visual intent | Typical use |
|------|---------------|-------------|
| Work / local primary | Highest within region | Session name, active file, current capability title, focused input |
| Secondary | Supporting but fully readable | supporting labels, secondary actions |
| Metadata | Quiet | Agent/location, recency, status details |
| Caption | Lowest readable hierarchy | helper text, keyboard hints |
| Code / terminal / mono | Workload-specific | terminal text, paths, commands, code |

Rules:

- one region should not contain multiple competing primary text roles;
- metadata never outweighs the thing it describes;
- monospace communicates code/terminal identity, not decoration;
- Web and App share semantic roles while Experience tokens may change sizes/hit areas;
- terminal glyph rendering remains owned by the terminal surface rather than chrome typography.

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

Its resting state should have a stable silhouette and few visible controls. `+`, shortcuts, capability identity, or secondary actions should appear progressively. When a capability becomes active, Nession can acknowledge it with precise, lightweight presence rather than immediately opening a large panel.

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

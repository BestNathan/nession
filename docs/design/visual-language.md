# Visual Language

What Nession looks like and why: the product visual principles, the typography / surface / density hierarchy systems, and the visual emphasis levels that let a screen say what must dominate and what must recede.

**Umbrella:** [#561](https://github.com/BestNathan/nession/issues/561)
**Upstream:** [product-model.md](product-model.md) · [information-architecture.md](information-architecture.md) · [interaction/web.md](interaction/web.md) · [interaction/app.md](interaction/app.md)
**Downstream:** [composition.md](composition.md) · [design-system/tokens.md](design-system/tokens.md) · [design-system/patterns.md](design-system/patterns.md) · [design-system/contracts.md](design-system/contracts.md)
**Status:** Phase 1 of #561 — vocabulary and rules. Exact values are locked only after the canonical screens (Phase 2) approve them; the screens are the approval vehicle.

## Position in the chain

```text
Product Model
      ↓
Information Architecture
      ↓
Interaction Model
      ↓
Visual Language             ← this document
      ↓
Layout / Composition
      ↓
Design Tokens
      ↓
Component Recipes
      ↓
Patterns
      ↓
Implementation
```

## What this document owns

- What must dominate and what must recede, and why — the product visual principles.
- Typography, surface, and density hierarchy systems.
- Visual emphasis levels and state-driven emphasis rules.

It does **not** own page geometry ([composition.md](composition.md)), token values ([tokens.md](design-system/tokens.md), #467), measurable rules ([contracts.md](design-system/contracts.md), #545), or component internals ([patterns.md](design-system/patterns.md), #470).

## The Nession signal

> **Terminal dominates. Chrome recedes. Healthy status stays quiet. Workspace augments the Session.**

Nession is a **precision instrument**, not a consumer app: dark, compact, terminal-native. The UI is a frame around the terminal, and the frame is styled as if it could render inside the terminal itself — flat surfaces, hairline separators, monospace where labels name code — built on platform primitives underneath. When a frame part competes with the terminal, the frame part is wrong.

Carried forward from the 2026-08-08 UI design protocol: heavy dark canvas, high contrast for terminal content, a single accent, and a visual hierarchy of `Terminal > Workspace > Metadata > Chrome`.

## 1. Product visual principles

**P1 — Terminal dominates.** The Terminal surface is the strongest visual weight in the app. When the Active Surface is Terminal, nothing else on screen is brighter, larger, or more attention-drawing.

**P2 — Chrome recedes.** Session navigation, headers, and switchers exist to serve the work surface. They are quiet by construction: restrained contrast, no decorative color, minimal size.

**P3 — Healthy is quiet; degraded gains emphasis.** `agent.online` renders as identity, not as a badge. Emphasis appears only when a domain condition threatens reachability or work: Agent offline/reconnecting/error, attachment `failed`, Session `exited`. The system never advertises health.

**P4 — One dominant action per region.** Each region has at most one primary action; everything else is secondary, ghost, or progressively disclosed. Two competing primary actions in one region is a visual-language error.

**P5 — Spacing groups; borders are exceptional.** Group related content with whitespace first. Borders, containers, and cards appear only when whitespace alone cannot separate — and a background shift is preferred over a border even then.

**P6 — Color communicates state or action, not decoration.** Accent appears where the user acts (selection, primary action) or where the system needs attention (degraded states). It never decorates chrome, rows, or marks.

**P7 — Metadata yields to workload.** Secondary text (Agent host, recency, tool labels) never competes with its region's primary content: the Session name, the terminal output, the file being edited.

**P8 — Disclose progressively, never occupy permanently.** Secondary controls hide behind hover, focus, selection, or menus. A healthy row shows no kill button; a healthy header shows no alarm.

**P9 — Empty space is intentional.** Whitespace is a hierarchy tool: chrome is sized so the work surface keeps the majority of the frame, and content is never stretched to fill space that should stay empty.

**P10 — Hierarchy over uniformity.** Consistency means every region obeys the same *relative* rules, not that everything is the same size. A row's primary text differs from its metadata by design; two regions with the same role use the same treatment.

## 2. Typography hierarchy

Roles are semantic, not raw sizes. A role defines relative emphasis, weight, line height, contrast, and where it may appear; the concrete values resolve through Experience tokens when #467 extends into type and are validated by the canonical screens.

| Role | Emphasis | Weight | Line height | Contrast | Appears when |
|------|----------|--------|-------------|----------|--------------|
| Product / page title | Secondary | Bold | Loose | Secondary | Only outside the working shell: login, settings, dialogs. No persistent product wordmark in the shell |
| Active Session title | Primary | Semi-bold | Tight | Highest in chrome | [SessionHeader](design-system/patterns/session-header.md); the only primary text in the header |
| Section title | Secondary | Semi-bold | Tight | Secondary | Workspace tool headers, dialog titles, list group labels |
| Primary content | Primary | Regular | Normal | Highest in region | Session name in [SessionItem](design-system/patterns/session-item.md); a region's hero text |
| Secondary content | Secondary | Regular | Normal | Secondary | SessionItem metadata line; supporting text below a primary |
| Metadata | Tertiary | Regular | Normal | Tertiary | Recency, Agent host, captions — never larger than secondary |
| Caption | Tertiary | Regular | Normal | Tertiary | Helper text, tooltips, keyboard hints |
| Code / terminal / mono | Independent | Regular | Normal | As its surface needs | Terminal text, file paths, commands, editor code |

Rules:

- **R-T1** A region carries at most one primary-level text. Two primaries in one region (e.g. Session name and Agent name at equal weight) is a hierarchy failure.
- **R-T2** Mono signals code and terminal identity: paths, commands, session names in terminal contexts, editor content. Mono is never decoration.
- **R-T3** Metadata is never larger or heavier than the secondary content it annotates.
- **R-T4** Web and App share the same roles. App scales sizes for touch density and safe-area reading; it never reorders roles or invents new ones.
- **R-T5** Terminal text is not chrome typography. xterm + Catppuccin own it ([web/CLAUDE.md](../../web/CLAUDE.md)); this hierarchy governs the UI around it, not the terminal glyphs themselves.

## 3. Surface hierarchy

Named surfaces, and the preferred mechanism that separates each from its neighbors.

Separation ladder — prefer the weakest cue that works, in this order:

```text
whitespace  >  background shift  >  border  >  radius  >  shadow / elevation
```

Never stack more than two separation cues on the same edge by default.

| Surface | Role | Default separation |
|---------|------|---------------------|
| App canvas | Ground of the app | None — the base background |
| Navigation surface | Sessions sidebar | Background shift vs canvas; hairline border only if shift alone is not legible |
| Primary work surface | Terminal | **Flush**; the darkest surface; no border, no card, no radius |
| Secondary work surface | Workspace tool region | Background shift vs canvas |
| Floating control surface | Composer / capsule, floating actions | Elevation (shadow); no border |
| Popover / overlay | Menu, sheet, dialog | Elevation over a dimmed canvas; contained radius |
| Destructive / warning surface | Confirm dialog, error state | Background tint + text color; no glow, no border stack |

Rules:

- **R-S1** The Terminal is not a box. The hero surface is flush and borderless; its content *is* the terminal.
- **R-S2** Selection uses one coherent cue. Do not stack background + border + shadow + accent on a selected row (the [SessionItem](design-system/patterns/session-item.md) anti-pattern).
- **R-S3** Bordered cards group *content* where whitespace fails (e.g. editor pane separators in Files) — never rows, headers, or the terminal.
- **R-S4** Overlays dim the canvas; they do not recolor the chrome behind them.
- **R-S5** Healthy chrome never elevates: no shadows on headers, sidebars, or rows in the default state. Elevation is reserved for floating controls and overlays.

## 4. Density hierarchy

One density everywhere is as wrong as equal contrast everywhere. Density is a hierarchy signal: the more a surface supports focused work, the denser it is; the more it supports scanning or input, the more relaxed.

| Context | Density | Rationale |
|---------|---------|-----------|
| Session navigation | Comfortable, scannable | Rows are read quickly; generous row height, quiet chrome |
| Terminal work surface | **Densest** | The work itself; surrounding chrome must not inflate it |
| Workspace tools | Dense | File trees, editors, detail surfaces |
| Forms / dialogs | Relaxed | Reading and input comfort |
| Metadata / status | Compact | Quiet by size as well as by contrast |
| Floating controls | Compact | Single-line capsule; does not grow with content |
| App touch interactions | Touch-target density | `experience.app.touchTarget.min` and larger hit areas, per platform |

Rules:

- **R-D1** Density follows role, not preference. A component does not choose its density; its surface does.
- **R-D2** Chrome density never compresses the terminal. Chrome is sized by its own content, never by viewport pressure.
- **R-D3** Web/App density differences are Experience token ids (#467) — never ad-hoc `if (mobile)` metrics in components (see [contracts.md](design-system/contracts.md) inheritance).

## 5. Visual emphasis

Explicit levels patterns and screens use to map content. Every visual element in a healthy screen should be classifiable.

| Level | Used for | Treatment |
|-------|----------|-----------|
| `primary` | A region's hero text or action | Highest contrast in the region; the only element allowed accent color (P4) |
| `secondary` | Supporting text, secondary actions | Quiet but fully readable |
| `tertiary` | Metadata, captions | Near-floor contrast |
| `quiet` | Healthy status, chrome decoration | Present but not perceived; never below accessibility floor |
| `conditional-prominent` | State-driven escalation | Quiet by default; jumps to `primary` treatment when its condition holds |

Rules:

- **R-E1** Emphasize problems, not facts. Healthy states live at `quiet` / `tertiary`; degraded states take `conditional-prominent`.
- **R-E2** Escalation is additive and specific: the failing channel gains prominence, the others stay (Agent `offline` grows [AgentContext](design-system/patterns/agent-context.md); the Session title and attachment channels remain).
- **R-E3** Alarm treatment (danger surfaces, error banners) never appears for healthy or merely informational states.
- **R-E4** Motion is subtle and state-driven; it communicates change, never celebrates it.

Canonical state-driven emphasis (the mapping patterns should quote):

| Domain condition | Emphasis change | Where |
|------------------|-----------------|-------|
| `agent.online` | `quiet` — identity only, no badge | [AgentContext](design-system/patterns/agent-context.md) |
| `agent.reconnecting` | `conditional-prominent`, medium | AgentContext phrase |
| `agent.offline` / `agent.error` | `conditional-prominent`, high — phrase + tint | AgentContext |
| `session.exited` | name treatment drops a level | [SessionItem](design-system/patterns/session-item.md) |
| `attachment.failed` | `conditional-prominent`, local | [ConnectionStatus](design-system/patterns/connection-status.md) attachment channel |
| All healthy | nothing gains emphasis | Default shell |

## 6. How this document is enforced

- **Phase 2 (#561):** the canonical screens (Web Active Terminal 1440×900, Web Workspace 1440×900, App Active Terminal 390×844) are the approval vehicle for every rule and value in this document. A rule that the screens cannot demonstrate is not a rule.
- **Phase 4 (#561):** pattern specs gain Visual Contract sections that quote the emphasis levels and anti-patterns from this document.
- **Phase 6–7 (#561):** golden screenshots capture the approved composition; CI protects it from drift. Visual regression prevents accidental change; it does not decide whether a design is good.
- **Contracts (#545):** measurable rules may reference hierarchy only where measurable; taste stays in prose.

## 7. What this document does not own

- Page geometry, insets, and rhythm → [composition.md](composition.md).
- Values (sizes, colors, radii) → [tokens.md](design-system/tokens.md) / #467.
- Measurable layout rules → [contracts.md](design-system/contracts.md) / #545.
- Component internals → [patterns.md](design-system/patterns.md) / #470.
- A second palette, or branded forks of generic primitives — never. Identity lives in these rules and in patterns, not in a custom button kit ([components.md](design-system/components.md)).

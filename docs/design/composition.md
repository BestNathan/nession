# Layout / Composition

Page-level composition relationships for the Session-first shell: shell geometry, chrome width/height strategies, insets, gutters, vertical rhythm, responsive transitions, and Web vs App differences.

**Umbrella:** [#561](https://github.com/BestNathan/nession/issues/561)
**Upstream:** [visual-language.md](visual-language.md) · [interaction/web.md](interaction/web.md) · [interaction/app.md](interaction/app.md) · [information-architecture.md](information-architecture.md)
**Downstream:** [design-system/tokens.md](design-system/tokens.md) · [design-system/contracts.md](design-system/contracts.md)
**Status:** Phase 3 of #561 — relationships and intent first. A value becomes a token only when implementation needs a stable reusable value (Phase 5). Do not treat every sentence here as a token.

## Position in the chain

```text
Interaction Model
      ↓
Visual Language
      ↓
Layout / Composition        ← this document
      ↓
Design Tokens
      ↓
Component Recipes / Patterns
      ↓
Implementation
```

## What this document owns

Page-level geometry and how regions relate: shell geometry, sidebar and header strategies, work-surface insets, gutters and max widths, vertical rhythm, large-screen whitespace, responsive transitions, edge-to-edge and contained-vs-flush rules, Web vs App composition.

It does **not** own hierarchy and emphasis ([visual-language.md](visual-language.md)), values ([tokens.md](design-system/tokens.md), #467), measurable rules ([contracts.md](design-system/contracts.md), #545), or what a component contains ([patterns.md](design-system/patterns.md), #470).

## 1. Web shell geometry

Canonical frame: `1440 × 900` (`web.standard-desktop` in the [#547 viewport matrix](design-system/validation.md#viewport-matrix-547)). Composition is judged at this frame and at `app.standard-phone` (390 × 844) for App.

```text
┌──────────────┬──────────────────────────────────────────────┐
│              │  SessionHeader                  (one row)    │
│              ├──────────────────────────────────────────────┤
│  Sessions    │                                              │
│  sidebar     │  Active Surface — owns ALL remaining space   │
│  (fixed,     │                                              │
│  content-    │     Terminal   (flush, borderless)           │
│  width)      │     XOR                                      │
│              │     Workspace  (inset tool content)          │
│              │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

Relationships, not values:

- The shell is **full-bleed**: no outer page gutter on desktop; chrome bands run edge to edge.
- The Active Surface owns every pixel the chrome does not consume. Chrome is sized by its own content; the surface absorbs the rest.
- Sidebar and header never grow when the window grows — extra space goes to the work surface (see §7).

## 2. Sidebar width strategy

- **Fixed, content-driven, not percentage.** The Sessions sidebar is wide enough for a [SessionItem](design-system/patterns/session-item.md) metadata line at its typography role — no wider. It does not scale with the viewport and is not resizable by default.
- Extra horizontal space belongs to the Active Surface, not to the sidebar.
- On compact widths the sidebar becomes an **overlay drawer** (Sheet), never a squeezed narrow column (see §8).
- No nested sidebars: Workspace tools use compact top navigation, not a second full-width column ([interaction/web.md](interaction/web.md#surface-vs-tool-navigation)).

## 3. Header / chrome height strategy

- One row of chrome per band: SessionHeader, Workspace tool nav. Never two stacked rows for the same band.
- Height is **content-driven** (a control row at its Experience height), not viewport-driven, and not title-driven.
- Budget intent: the total chrome stack (sidebar band + header band) must remain a small fraction of the frame; the Terminal keeps the clear majority of vertical space. Chrome never grows to absorb viewport growth.
- The header identifies and provides context; it does not advertise ([visual-language.md](visual-language.md) P2/P3).

## 4. Primary work-surface insets

- **Terminal is flush within its region**: no page padding around xterm, no card, no radius, no border ([visual-language.md](visual-language.md) R-S1). Only the terminal's own internal cursor-comfort padding applies.
- **Workspace tool content is inset** with a modest uniform margin; tool content breathes. The inset is a property of the tool region, not of individual components.
- Files master/detail defines its own internal gutters; they stay inside the Workspace region ([workspace.md](workspace.md)).

## 5. Page gutters and content max widths

- The shell is full-bleed; gutters exist **inside** regions (list row padding, header padding, tool insets) — never as an outer frame.
- **Max width** is allowed only for reading content inside Workspace (e.g. editor text). Never for the terminal, never for the shell, never as an app-level centered column.
- Lists fill their region; only prose-like content constrains.

## 6. Vertical rhythm

- Chrome and tool spacing follow one small base unit (a 4 px grid relationship — the value is a Phase 5 concern). Spacing = base × n; no bespoke step lists per component.
- The terminal is **exempt**: its content owns its own grid; chrome rhythm stops at the terminal boundary.

## 7. Large-screen whitespace behavior

- Extra width on wide viewports goes to the work surface (the terminal), never to chrome padding, never to a stretching sidebar.
- No floating card / centered-column layouts on large screens. Whitespace is where the work surface lives, not decoration around a column.

## 8. Responsive transition rules (Web)

- **Wide (≥ `lg` ~1024 px):** persistent sidebar + full surface, as in §1.
- **Compact (< `lg`):** the Sessions sidebar becomes an overlay drawer (Sheet) over a full-width Active Surface; the SurfaceSwitcher stays; the header stays one row. Chrome never stacks vertically.
- Order of sacrifice: **chrome yields first, the work surface yields last.** Terminal viewport priority is the invariant across all widths.
- `lg` signals which family applies; `viewports.json` (#547) owns the actual sizes. Tests take expectations from contract `web` blocks, never ad-hoc conditionals ([validation.md](design-system/validation.md)).
- Narrow Web is not App: Web on a phone is still the Web shell with a drawer, not the App spatial model ([interaction/app.md](interaction/app.md)).

## 9. Web vs App composition

| | Web | App |
|--|-----|-----|
| Navigation | Persistent sidebar (drawer below `lg`) | Sessions drawer layer; no persistent column |
| Surfaces | Terminal \| Workspace via SurfaceSwitcher | Spatial `Sessions ← Terminal → Workspace` ([interaction/app.md](interaction/app.md)) |
| Chrome | One header row, full-width band | Compact header + safe-area insets (notch / home indicator) |
| Work surface | Terminal owns the surface region | Terminal owns the maximum mid-screen region; layers overlay it |
| Controls | Pointer density | Touch-target density; visible non-gesture controls required |
| Affordances | Hover/focus disclosure | Thumb-reach placement per platform |

App composes the same surfaces and hierarchy with its own geometry; it is not a compressed Web layout.

## 10. Edge-to-edge rules

- Chrome bands (sidebar, header, tool nav) are **edge-to-edge** — flush with the screen/frame.
- The Terminal surface is **flush within its region** — the only work surface that is edge-to-edge by default.
- Workspace tool content is inset; overlays and dialogs are contained.

## 11. Contained vs flush

Containment is a **content decision**, not a chrome preference:

| Content | Treatment |
|---------|-----------|
| Terminal | Flush |
| File lists, session lists | Flush (fill the region) |
| Editor / reading text | Contained: inset + optional max width |
| Forms, dialogs, details | Contained |

## 12. Canonical frames

- Composition is judged at `web.standard-desktop` (1440 × 900) and `app.standard-phone` (390 × 844) — the matrix ids of [#547](design-system/validation.md#viewport-matrix-547); sizes live only in `design/contracts/viewports.json`.
- The Phase 2 canonical screens ([#561](https://github.com/BestNathan/nession/issues/561)) are the approval vehicle for the relationships in this document.

## 13. Tokenization rule

Keep as **relationships** (do not tokenize prematurely):

- Sidebar = metadata-line width; header = one content row.
- Terminal = flush; chrome budget = small fraction of the frame.
- Responsive transition semantics (chrome yields first, work surface last).

Promote to **tokens only when stable and needed** (Phase 5 convergence):

- Sidebar width, header height, base spacing unit, tool insets — once the canonical screens approve them and implementation requires a shared value.

**Forbidden as a substitute:** new local metric variables (e.g. `--sf-*` extensions) invented to express composition on top of the token model ([#561](https://github.com/BestNathan/nession/issues/561) non-goals; [tokens.md](design-system/tokens.md) layer stack).

## What this document does not own

- Hierarchy and emphasis → [visual-language.md](visual-language.md).
- Values → [tokens.md](design-system/tokens.md) / #467.
- Measurable rules → [contracts.md](design-system/contracts.md) / #545.
- Component internals → [patterns.md](design-system/patterns.md) / #470.
- Which viewport sizes exist → `design/contracts/viewports.json` (#547).

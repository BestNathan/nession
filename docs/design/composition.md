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

Page-level geometry and how regions relate: shell geometry, drawer and chrome strategies, work-surface insets, gutters and max widths, vertical rhythm, large-screen whitespace, responsive transitions, edge-to-edge and contained-vs-flush rules, Web vs App composition.

It does **not** own hierarchy and emphasis ([visual-language.md](visual-language.md)), values ([tokens.md](design-system/tokens.md), #467), measurable rules ([contracts.md](design-system/contracts.md), #545), or what a component contains ([patterns.md](design-system/patterns.md), #470).

## 1. Web shell geometry

Canonical frame: `1440 × 900` (`web.standard-desktop` in the [#547 viewport matrix](design-system/validation.md#viewport-matrix-547)). Composition is judged at this frame and at `app.standard-phone` (390 × 844) for App.

```text
┌────────────────────────────────────────────────────────────────────┐
│ [≡]  fix-terminal-reconnect · online · active · attached           │
│                                           [Terminal | Workspace]  ● │ ← 唯一常驻行
│                                                                    │
│                      TERMINAL (全屏,唯一亮面)                      │
│                                                                    │
│                           [ 输入胶囊  ▸ ]                          │
└────────────────────────────────────────────────────────────────────┘
```

Relationships, not values:

- The shell is **full-bleed**: no outer page gutter on desktop. There is **no global chrome bar** — no product wordmark, no app-level band. The **only persistent chrome is the top row** (two text rows, ≈ 60 px): the drawer button + session line + `[Terminal | Workspace]` + server micro-status. The persistent sidebar is gone — sessions live in a drawer overlay opened from `[≡]`.
- The resting state (no session selected) still renders the top row — drawer button + server status — over an empty state; sessions are always one `[≡]` away.
- The Active Surface owns every pixel the chrome does not consume. Chrome is sized by its own content; the surface absorbs the rest.
- Top row and drawer never grow when the window grows — extra space goes to the work surface (see §7).

## 2. Drawer width strategy

- **No persistent column.** Sessions live in a left overlay drawer — `w-[min(20rem,90vw)]`, scrim + slide-in — opened from the top-row `[≡]` button. The resting state has **no sidebar at all**.
- The drawer is wide enough for a [SessionItem](design-system/patterns/session-item.md) metadata line at its typography role — no wider; on compact widths it caps at 90vw. Not resizable by default.
- The drawer overlays the Active Surface (scrim + elevation); the surface never shrinks or shifts to make room for it.
- Extra horizontal space belongs to the Active Surface, never to the drawer.
- The drawer holds search / filter / create / session rows. Its head's three stacked rows are known to exceed the visual-language intent of a single quiet head row; compacting it to one row is tracked as a follow-up (the approved mockup shows a one-line head).
- No nested sidebars: Workspace tools live in the bottom floating tool bar; never a second full-width column ([interaction/web.md](interaction/web.md#surface-vs-tool-navigation)).

## 3. Chrome height strategy

- One band of chrome per region: the top row, Workspace tool nav. Never two stacked bands for the same region.
- The top row is **two text rows, not a bordered bar**: a mono title row (drawer button + session name) over a muted context row (host · status · attachment, right-aligned `[Terminal | Workspace]` + server micro-status). It reads as text on canvas, not as a header control.
- The server connection status lives in the **top row** as quiet mono micro-text — never as a badge ([visual-language.md](visual-language.md) P3).
- Height is **content-driven** (text rows at their typography roles), not viewport-driven, and not title-driven.
- Budget intent: the top row (≈ 60 px) plus the floating input capsule — and, when Workspace is active, the bottom floating tool bar — must remain a small fraction of the frame; the Terminal keeps the clear majority of vertical space. Chrome never grows to absorb viewport growth.
- The session line identifies and provides context; it does not advertise ([visual-language.md](visual-language.md) P2/P3).

## 4. Primary work-surface insets

- **Terminal is flush within its region**: no page padding around xterm, no card, no radius, no border ([visual-language.md](visual-language.md) R-S1). Only the terminal's own internal cursor-comfort padding applies.
- **Workspace tool content is inset** with a modest uniform margin; tool content breathes. The inset is a property of the tool region, not of individual components.
- Files master/detail defines its own internal gutters; they stay inside the Workspace region ([workspace.md](workspace.md)).

## 5. Page gutters and content max widths

- The shell is full-bleed; gutters exist **inside** regions (list row padding, chrome padding, tool insets) — never as an outer frame.
- **Max width** is allowed only for reading content inside Workspace (e.g. editor text). Never for the terminal, never for the shell, never as an app-level centered column.
- Lists fill their region; only prose-like content constrains.

## 6. Vertical rhythm

- Chrome and tool spacing follow one small base unit (a 4 px grid relationship — the value is a Phase 5 concern). Spacing = base × n; no bespoke step lists per component.
- The terminal is **exempt**: its content owns its own grid; chrome rhythm stops at the terminal boundary.

## 7. Large-screen whitespace behavior

- Extra width on wide viewports goes to the work surface (the terminal), never to chrome padding, never to a widening drawer.
- No floating card / centered-column layouts on large screens. Whitespace is where the work surface lives, not decoration around a column.

## 8. Responsive transition rules (Web)

- **Wide (≥ `lg` ~1024 px):** top row + full-bleed surface, as in §1; sessions open as a drawer overlay on demand.
- **Compact (< `lg`):** the same shell — the drawer caps at 90vw over a full-width Active Surface; the SurfaceSwitcher stays; the top row stays one band. Chrome never stacks vertically.
- Order of sacrifice: **chrome yields first, the work surface yields last.** Terminal viewport priority is the invariant across all widths.
- `lg` signals which family applies; `viewports.json` (#547) owns the actual sizes. Tests take expectations from contract `web` blocks, never ad-hoc conditionals ([validation.md](design-system/validation.md)).
- Narrow Web is not App: Web on a phone is still the Web shell with a drawer, not the App spatial model ([interaction/app.md](interaction/app.md)).

## 9. Web vs App composition

| | Web | App |
|--|-----|-----|
| Navigation | Sessions drawer overlay (left, scrim + slide-in) | Sessions drawer layer; no persistent column |
| Surfaces | Terminal \| Workspace via SurfaceSwitcher | Spatial `Sessions ← Terminal → Workspace` ([interaction/app.md](interaction/app.md)) |
| Chrome | Top row (drawer button + session line + switcher + server micro-status); no band | Compact header + safe-area insets (notch / home indicator) |
| Work surface | Terminal owns the surface region | Terminal owns the maximum mid-screen region; layers overlay it |
| Controls | Pointer density | Touch-target density; visible non-gesture controls required |
| Affordances | Hover/focus disclosure | Thumb-reach placement per platform |

App composes the same surfaces and hierarchy with its own geometry; it is not a compressed Web layout.

## 10. Edge-to-edge rules

- Chrome bands (top row, drawer panel, tool nav) are **edge-to-edge** — flush with the screen/frame.
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

- Drawer = metadata-line width (capped `min(20rem,90vw)`); top row = two text rows.
- Terminal = flush; chrome budget = small fraction of the frame.
- Responsive transition semantics (chrome yields first, work surface last).

Promote to **tokens only when stable and needed** (Phase 5 convergence):

- Drawer width, top row height, base spacing unit, tool insets — once the canonical screens approve them and implementation requires a shared value.

**Forbidden as a substitute:** new local metric variables (e.g. `--sf-*` extensions) invented to express composition on top of the token model ([#561](https://github.com/BestNathan/nession/issues/561) non-goals; [tokens.md](design-system/tokens.md) layer stack).

## What this document does not own

- Hierarchy and emphasis → [visual-language.md](visual-language.md).
- Values → [tokens.md](design-system/tokens.md) / #467.
- Measurable rules → [contracts.md](design-system/contracts.md) / #545.
- Component internals → [patterns.md](design-system/patterns.md) / #470.
- Which viewport sizes exist → `design/contracts/viewports.json` (#547).

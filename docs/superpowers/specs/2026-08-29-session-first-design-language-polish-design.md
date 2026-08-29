# Session-first Design Language Polish

**Date:** 2026-08-29  
**Status:** Draft for review  
**Parent:** [#492](https://github.com/BestNathan/nession/issues/492) (V1–V4 ChatGPT-style shell)  
**Skill input:** `ui-ux-pro-max` (Minimalism / Swiss adapted to existing light chrome + dark well — **not** OLED / all-mono retheme)  
**Depends on:** V1–V4 on `staging`

---

## Goal

Evolve the **session-first** visual language for clarity, accessibility, and touch consistency — without changing IA, surfaces, or flipping `session_first` default.

Keep: light chrome + dark terminal well (`--sf-terminal-well`), Inter UI + JetBrains Mono for code/meta, Lucide icons, shadcn primitives.

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Scope | **Session-first only** (`.session-first-shell` / `web/src/session-first/**`) |
| Approach | Thin **token overlay** under `.session-first-shell` + component sweep |
| Priority | Token + interaction polish (spacing, type hierarchy, focus, motion, touch) |
| Theme | Keep light shell + dark well; no OLED / all-mono / Dashboard restyle |
| Cutover | No `#472` PR7; flag stays off |

---

## Token overlay

Extend the existing `.session-first-shell` light lock in `web/src/index.css` (or a colocated `session-first/tokens.css` imported once) with:

| Token family | Intent |
|--------------|--------|
| Spacing | 4 / 8 / 12 / 16 / 24px rhythm for chrome (header, list row, footer, capsule padding) |
| Type | Title / secondary / muted hierarchy; body contrast ≥ **4.5:1**; mono only for IDs, paths, terminal meta |
| Focus | Ring ≥ **2px** + offset; 3:1 against adjacent bg; never strip focus for aesthetics |
| Motion | Hover/press **150–250ms**; skip non-essential motion under `prefers-reduced-motion` |
| Radius | Keep current soft radii; no new multi-layer shadow system |

Do **not** retune global `:root` in a way that restyles legacy Dashboard.

---

## Component sweep

Touch these surfaces only as needed for tokens/interaction:

- `SessionFirstShell` / chrome / sidebar / list header / session rows  
- `SessionHeader` (incl. back)  
- `TerminalCapsule` (build on V4 hit targets / safe-area)  
- Overflow / footer controls  

Rules:

- Semantic tokens / CSS vars only — no raw `bg-blue-*` / one-off hex in TSX  
- Icon-only controls: Lucide + `aria-label` (and tooltip where already used)  
- Narrow (`max-lg`): ≥ **44px** hit targets for primary chrome controls  
- Kill / destructive: not hover-only on touch (keep V2 selected / `focus-within` rule)  
- Capsule modes remain **Input | Commands** — no Env  

---

## Approach

1. Define overlay vars on `.session-first-shell`.  
2. Sweep components to consume them (and fix focus/hover/touch gaps).  
3. Tests: class/token presence where practical; Playwright desktop + 375 (list, detail+capsule, keyboard focus visible).  

No new mobile chrome component. No IA / XOR changes.

---

## Files (plan will lock)

| Area | Touch |
|------|--------|
| Tokens | `web/src/index.css` (`.session-first-shell`) and/or `web/src/session-first/tokens.css` |
| Shell / sidebar / header / list / capsule | Existing session-first components from V1–V4 |
| Tests | Extend shell/header/capsule/list tests; Playwright screenshots |

**Do not touch:** `sessionFirst.ts` default, legacy Dashboard / BottomBar, soft-keyboard `visualViewport`, `k8s/overlays/**`.

---

## Acceptance

- [ ] Session-first chrome feels calmer and more consistent; IA unchanged  
- [ ] Focus rings visible; `prefers-reduced-motion` respected  
- [ ] 375: primary controls ≥44px; Kill usable without hover  
- [ ] Capsule still Input/Commands only; well stays dark  
- [ ] Legacy Dashboard visually unchanged  
- [ ] `just web-lint` / `just web-test`; Playwright on the PR  
- [ ] `session_first` default still **off**  

---

## Non-goals

- Full rebrand / dark product chrome / JetBrains Mono for all UI text  
- Legacy Dashboard or Login redesign (except unavoidable shared var bleed — avoid by scoping overlay)  
- New navigation patterns or surfaces  
- `#472` cutover  

---

## Delivery

| Item | Target |
|------|--------|
| Spec | this doc → `main` |
| Implementation | worktree from `origin/staging`; PR → `staging` |
| Tracking | Follow-up issue or comment on #492 (no premature `Closes`) |

---

## ui-ux-pro-max notes (applied)

- **Style used:** Minimalism / Swiss — clean, high contrast, functional (adapted to **light** chrome).  
- **Rejected default:** OLED + all-mono (conflicts with shipped V1–V4 ChatGPT shell).  
- **Stack:** React + Tailwind v4 + shadcn — semantic CSS variables, complete focus treatment.  
- **UX:** Touch ≥44px (narrow), focus appearance, contrast, reduced-motion, Lucide not emoji.

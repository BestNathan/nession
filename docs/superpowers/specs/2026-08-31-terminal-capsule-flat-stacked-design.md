# Terminal Capsule — Flat / Stacked Composer

**Date:** 2026-08-31  
**Status:** Approved  
**Parent:** [#492](https://github.com/BestNathan/nession/issues/492) (session-first shell)  
**Builds on:** Capsule rewrite on `staging` (`session-first/capsule/**`, soft-expand height tween)  
**Related:** Terminal capsule redesign (2026-08-31) — capability model on `staging` (sheet removed, popovers, ghost+Tab). This doc **replaces** that redesign’s single-row-with-side-tools growth model for Input with an explicit **flat ↔ stacked** composer layout + FLIP motion.

---

## Goal

Fix capsule Input **animation hardness** and **control placement** by making layout **content-driven** and transitions **spatially continuous**:

- Single-line (or empty) → **flat** strip: tools flank the input.
- Multi-line (≥2) → **stacked** ChatGPT column: full-width input on top, **same** tools on a fixed bottom toolbar.
- Morph between states with **FLIP** on tools + **height** tween on the textarea — no tool teleport, no pill↔rect radius snap.

---

## Problems with current Input composer (staging)

- Soft-expand keeps tools in a fixed side row while only height grows. That avoids teleport but never matches the ChatGPT “input above / chrome below” IA users expect once the field is tall.
- Earlier grid/`row-start` and `rounded-full` ↔ `rounded-2xl` switches felt hard because layout and chrome shape jumped without a continuous motion path.
- Focus-driven expand was considered and **rejected** — layout must follow content, not focus, so typing a single line never suddenly reflows the dock.

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Expanded IA | **Stacked**: input full width on top; toolbar row fixed below |
| Collapsed IA | **Flat**: one strip; tools left + right of input |
| Control set | **Identical** in flat and stacked — only layout changes |
| Expand trigger | Content **≥2 lines** only (hard breaks + `scrollHeight` measure, same as today) |
| Collapse trigger | Content back to **1 line**, or **send** (clears → empty → flat) |
| Focus | **Does not** change layout |
| Motion | **FLIP** on toolbar controls + height tween on textarea |
| Shell radius | Always `rounded-3xl` — never pill↔rect swap |
| Desktop | Same flat/stacked model |
| Mobile Input | Same flat/stacked model |
| Mobile Commands | Unchanged single-row quick keys + `⋯`; **not** in flat/stacked state machine |
| Scope | Session-first capsule path only; legacy BottomBar untouched |
| Flag | `session_first` default stays off |

---

## Layout states

Input mode has exactly two layout states. Commands mode (mobile) does not use them.

### `flat`

```
[ left tools … ] [ input (1 line) + ghost ] [ … right tools / Send ]
```

- One visual strip inside the floating capsule.
- Shell: `rounded-3xl`, `--sf-capsule-surface`, existing desktop max-width / mobile inset + safe-area positioning unchanged.

### `stacked`

```
[              input (full width, grows to max 5 lines then scroll)              ]
[ left tools …                                      … right tools / Send ]
```

- Column flex: textarea row, then toolbar row (`items` as today for hit targets).
- Tool **identity and order** match `flat` (see Control inventory).

### Line counting

Unchanged from soft-expand:

- `lineCount = max(hardBreakLines, ceil((scrollHeight - padY) / linePx))`
- `lineCount >= 2` → `stacked`; else → `flat`
- Max height: 5 lines then internal scroll (`CAPSULE_MAX_*` constants)

---

## Motion (FLIP)

### Sequence on layout change

1. **First:** `getBoundingClientRect()` for each morphing control (History, Commands, Paste, Copy, Send, and mobile Mode toggle when present).
2. Apply DOM layout (`flat` ↔ `stacked`).
3. **Last:** measure again; set `transform` to Invert; next frame animate `transform` → `none` (**Play**).
4. Textarea animates **`height` only** (~280ms, `cubic-bezier(0.22, 1, 0.36, 1)`); it does not participate in FLIP translation.

### Parameters

| Property | Value |
|----------|--------|
| Tool FLIP duration | 220–280ms, same easing as height |
| Shell shape | Always `rounded-3xl`; optional light padding tween only |
| Rapid toggles | Cancel in-flight FLIP; remeasure from current positions (no queue) |
| `prefers-reduced-motion: reduce` | Skip FLIP; ≤150ms opacity fade + instant layout |

### Focus and popovers during morph

- Keep **textarea focus** across the transition.
- Morph the **same DOM nodes** for tools (no unmount/remount of triggers).
- If History/Commands popover is open during a non-send layout change: **stay open**; trigger FLIPs; Radix re-anchors.
- On **send** (clear): close open History/Commands popovers (empty composer — avoid orphaned panels).

### Forbidden

- Teleporting tools via `grid-row` / `row-start` without FLIP
- Swapping `rounded-full` ↔ `rounded-2xl` (or equivalent) as the expand signal

---

## Control inventory

Capabilities unchanged; reuse existing capsule popovers, hooks, and send semantics.

### Desktop Input

| Flat placement | Controls |
|----------------|----------|
| Left | History, Commands |
| Right | Paste, Copy, Send |

Stacked: same controls on the bottom toolbar — left cluster History/Commands, right Paste/Copy/Send; input alone on the top row.

### Mobile Input

| Flat placement | Controls |
|----------------|----------|
| Left | Mode toggle, History |
| Right | Send |

No Paste/Copy/Commands button on mobile Input (Commands via mode). Stacked: same set on the bottom toolbar; Mode toggle stays leftmost on that bar.

### Mobile Commands (out of scope for morph)

```
[ Mode toggle ] [ quick phys keys … ] [ ⋯ ]
```

Chain banner above dock when active — unchanged.

### Shared Input behaviors (unchanged)

- Ghost suffix + Tab accept; disabled while IME composing
- Enter sends; Shift+Enter newline (drives line count → layout)
- History ↔ Commands popovers mutually exclusive
- `toolbarDisabled` disables the whole capsule
- No textarea focus ring (keep current CSS override)
- Tokens: `--sf-capsule-surface`, `--sf-terminal-well`, `--sf-motion` / `--sf-ease` where applicable; no primitive colors in TSX
- Mobile primary controls ≥44px under `max-lg`

---

## Architecture (implementation sketch)

Stay inside `web/src/session-first/capsule/`. Prefer evolving existing pieces over a parallel composer.

| Unit | Responsibility |
|------|----------------|
| `TerminalCapsule` | Variant/mode shell; Commands path unchanged; Input path hosts composer |
| `CapsuleInputRow` (or rename `CapsuleComposer`) | Owns `flat` \| `stacked` from line count; wires FLIP host |
| `CapsuleGhostInput` | Height measure + height tween; reports line count |
| Toolbar clusters | Single DOM for left/right (or one toolbar flex that reflows); FLIP targets |
| `useCapsuleLayoutFlip` (new) | First/Last/Invert/Play helper; reduced-motion branch |

Props surface for `TerminalCapsule` stays capability-compatible (`sendText`, `disabled`, `variant`, `mode`, `onModeChange`). No return of sheet / `expanded` / legacy panels.

---

## Edge cases

| Case | Behavior |
|------|----------|
| Delete from 2 lines → 1 | Animate to `flat` immediately (no blur wait) |
| Send clears input | → `flat`; close History/Commands if open |
| Paste jumps to ≥2 lines | One transition into `stacked` |
| Spam newline/backspace | Cancel + re-FLIP; no animation queue |
| `disabled` | No input; freeze layout; no morph |
| Open popover + line morph | Stay open; re-anchor (except send clear) |

---

## Accessibility

- Keep `aria-autocomplete="inline"` on the ghost input.
- Do not move focus from the textarea during FLIP.
- Toolbar buttons remain in tab order; same accessible names.
- Honor `prefers-reduced-motion` as specified above.

---

## Non-goals

- Redesign legacy BottomBar / `InputPanel` / `QuickCommandsPanel`
- Env / Files in capsule
- Desktop Commands mode toggle
- Focus-driven expand/collapse
- Changing quick-command server API
- Visual companion mockups (explicitly declined for this brainstorm)

---

## Acceptance

- [ ] Desktop + mobile Input: single-line/`empty` → flat; ≥2 lines → stacked; delete-to-one-line and send-clear return to flat
- [ ] Flat ↔ stacked: tools move continuously (FLIP); height eases; no radius snap; reduced-motion fades only
- [ ] Control sets match inventory; Commands mode behavior unchanged
- [ ] Ghost + Tab, popover mutex, disabled, tokens, and touch targets preserved
- [ ] Unit/integration tests cover layout state transitions (and FLIP reduced-motion path where practical)
- [ ] `just web-lint` / `just web-test` pass; Playwright screenshots on PR comment for flat and stacked

---

## Delivery

| Item | Target |
|------|--------|
| Spec | this doc → PR to `main` (`docs/**`) |
| Implementation | worktree from `origin/staging`; PR → `staging` |
| Tracking | Comment on #492 |

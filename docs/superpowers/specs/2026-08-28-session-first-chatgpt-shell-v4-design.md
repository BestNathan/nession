# Session-first ChatGPT Shell — V4 Design (Mobile / Narrow Polish)

**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)  
**Parent design:** [`2026-08-28-session-first-chatgpt-shell-design.md`](./2026-08-28-session-first-chatgpt-shell-design.md)  
**Depends on:** V1–V3 on `staging` (light shell, history sidebar, TerminalCapsule)  
**Status:** Draft for review  

---

## Goal

Ship **V4**: narrow-viewport (**~375 / `< lg`**) visual and touch polish so list XOR detail + the floating capsule match the desktop ChatGPT-style shell language. No IA change. Flag stays **off** until #472 PR7.

Validate with `?session_first=1` at 375×812 (and desktop regression smoke).

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Scope | **Visual/touch polish only** — keep #472 list XOR detail + V3 capsule |
| Approach | **Restyle-in-place** under `max-lg` / shared capsule props — no new mobile chrome component |
| Capsule | Larger hit targets; bottom **safe-area**; tighter expanded sheet height on narrow; **no** new modes |
| Keyboard | **No** `visualViewport` avoidance — rely on `100dvh` + safe-area (YAGNI) |
| Chrome | Keep back-to-list; tighten spacing/type; New Session / Filters / footer overflow stay usable |
| Desktop | No intentional desktop layout redesign; shared capsule tweaks must stay harmless at `lg+` |
| Scope boundary | **Session-first only**; legacy Dashboard untouched |

---

## List XOR detail chrome

- Below `lg`: one column — **list or detail** via existing `useSessionFirstMobileNav`
- Keep `session-first-back-to-list` in the session header when detail is shown
- Tighten padding / typography so the column matches V1–V2 calmness without horizontal clipping
- Kill remains visible on **selected** / `focus-within` (V2 touch rule) — no new row `⋯`
- Sidebar footer overflow (Env / ServerInfo / Legacy) remains reachable on the list column

Non-goal: restyling back into a labeled “Sessions” button (can revisit later).

---

## Capsule on narrow viewports

`TerminalCapsule` already ships from V3 (desktop + `terminalOnly` mobile). V4 adjusts presentation:

- Bottom inset: existing well inset **plus** `env(safe-area-inset-bottom)`
- Collapsed controls: ≥ ~44px touch height under narrow breakpoints
- Expanded sheet: slightly tighter `max-h` on mobile (e.g. ~28vh vs ~32vh desktop) so xterm stays readable
- Modes remain **Input | Commands** only — still no Env / Files / voice
- `toolbarDisabled` behavior unchanged; xterm keep-alive unchanged

---

## Approach

Prefer Tailwind `max-lg:` / safe-area utilities on existing session-first surfaces (`SessionFirstShell`, sidebar, `SessionHeader`, `TerminalCapsule`, related chrome). Avoid extracting a `MobileSessionChrome` wrapper unless restyle-in-place becomes unreadable (not expected for this scope).

---

## Files (plan will lock)

| Area | Touch |
|------|--------|
| Capsule | `session-first/TerminalCapsule.tsx` + tests |
| Shell / sidebar | `SessionFirstShell`, `SessionFirstSidebar`, list header/footer as needed |
| Header | `patterns/SessionHeader.tsx` (back control spacing) |
| Layout hosts | Only if padding/safe-area must live on well / mobile terminal host |
| Tests | Capsule + shell/header mobile assertions; Playwright 375 screenshots |

**Do not touch:** `sessionFirst.ts` default, legacy BottomBar / Dashboard, `k8s/overlays/**`, soft-keyboard `visualViewport` helpers.

---

## Acceptance

- [ ] 375: same light shell language as desktop V1–V2; list XOR detail; back returns to list  
- [ ] 375 Terminal: collapsed capsule with usable hit targets + safe-area; expand → Input / Commands only (no Env)  
- [ ] Expanded sheet does not dominate the well (height capped)  
- [ ] Attach / Workspace Files / Agent / deep link / keep-alive unchanged  
- [ ] Desktop `lg+` not regressively broken  
- [ ] `just web-lint` / `just web-test`; Playwright screenshots on the PR  
- [ ] `session_first` default still **off**  

---

## Non-goals

- Soft-keyboard `visualViewport` tracking  
- New mobile chrome component / nav model  
- Capsule collapse-on-outside-tap as a required behavior  
- `#472` cutover / default-on (**PR7**)  
- Chat / AI runtime chrome; dual-theme dark shell  

---

## Delivery

| PR | Scope |
|----|--------|
| V1–V3 | Landed on staging |
| **V4** (this doc) | Narrow viewport polish (list XOR detail + capsule) |
| Then | #472 PR7 |

Worktree base: `origin/staging`. PR base: `staging`.

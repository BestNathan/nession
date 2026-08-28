# Session-first ChatGPT Shell — V3 Design (Terminal Capsule)

**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)  
**Parent design:** [`2026-08-28-session-first-chatgpt-shell-design.md`](./2026-08-28-session-first-chatgpt-shell-design.md)  
**Depends on:** V1–V2 on `staging` (light shell, Terminal well, history sidebar)  
**Status:** Draft for review  

---

## Goal

Ship **V3**: replace the session-first **BottomBar** path with a **floating Input / Commands capsule** inside the dark Terminal well. Collapsed by default on desktop and mobile. Reuse existing InputPanel / QuickCommands semantics — not a chat composer.

Flag stays **off** until #472 PR7. Validate with `?session_first=1`.

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Default state | **Collapsed** on desktop and mobile |
| Placement | Float **inside** the Terminal well (over xterm) |
| Scope | **Session-first only** — legacy Dashboard `BottomBar` unchanged |
| Implementation | New `TerminalCapsule` component; wire via TerminalLayout / MobileTerminalLayout session-first path |

---

## Collapsed pill (default)

Absolutely positioned near the bottom of the Terminal well, with safe-area padding.

**Left → right:**
- Expand affordance (`+` / chevron) — opens the sheet  
- Compact field: Input compose **or** Commands shortcut entry depending on mode  
- Mode pill: **Input** | **Commands**  
- Primary send / action  

**Rules:**
- `toolbarDisabled` disables / hides the whole capsule  
- No Env, Files, or voice / waveform  
- Not a chat transcript  

---

## Expanded sheet

- Opens from the expand control (or equivalent)  
- Light sheet ~28–32vh rising **above** the still-visible pill, still **inside** the well  
- Soft radius; **does not unmount** xterm (keep-alive)  
- **Input** → `InputPanel`; **Commands** → `QuickCommandsPanel`  
- No Env / Files tabs (Env = sidebar footer; Files = Workspace)  
- Collapse control + Esc (when sheet focused, desktop) closes sheet  
- Mobile: larger hit targets; works with #472 `terminalOnly` (no Files/Env swipe via capsule)  

---

## Approach

New `web/src/session-first/TerminalCapsule.tsx`. Session-first `TerminalLayout` / `MobileTerminalLayout` (`terminalOnly`) use capsule instead of `BottomBar`. Leave legacy BottomBar callers alone.

---

## Files (plan will lock)

| Area | Touch |
|------|--------|
| Capsule | `session-first/TerminalCapsule.tsx` + integration tests |
| Desktop | `TerminalLayout.tsx` — opt-in capsule chrome for session-first |
| Mobile | `MobileTerminalLayout.tsx` — capsule when `terminalOnly` |
| Wire | `SessionFirstTerminal.tsx` — enable capsule |
| Reuse | `InputPanel`, `QuickCommandsPanel` (unchanged semantics) |

---

## Acceptance

- [ ] `?session_first=1` Terminal: collapsed pill inside dark well by default (desktop + mobile)  
- [ ] Expand → Input / Commands only; no Env/Files in capsule  
- [ ] `toolbarDisabled` disables capsule; xterm keep-alive / attach / Workspace / deep link unchanged  
- [ ] Legacy Dashboard BottomBar still has Input/Commands/Env/(Files)  
- [ ] `just web-lint` / `just web-test`; Playwright screenshots on the PR  
- [ ] `session_first` default still **off**  

---

## Non-goals

- Narrow viewport polish beyond capsule basics (**V4**)  
- `#472` cutover / default-on (**PR7**)  
- Migrating legacy BottomBar to capsule  
- Chat / AI runtime chrome  
- Voice send  

---

## Delivery

| PR | Scope |
|----|--------|
| **V3** (this doc) | Floating capsule; retire session-first BottomBar path |
| V4 | Narrow viewport polish (list XOR detail + capsule) |
| Then | #472 PR7 |

Worktree base: `origin/staging`. PR base: `staging`.

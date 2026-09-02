# TerminalCapsule

Floating Input / Commands composer inside the **Terminal** surface (session-first path only).

## Purpose

Send keyboard input and quick physical keys to the attached tmux session without turning Nession into a chat client.

Must not host Env, Files, session list, or Workspace tools. Must not replace legacy BottomBar on the Agent-first Dashboard path.

**Parent issues:** [#492](https://github.com/BestNathan/nession/issues/492) (visual shell), [#561](https://github.com/BestNathan/nession/issues/561) (visual language).

## Anatomy

```text
┌─ Terminal well ─────────────────────────────────────────┐
│  xterm (keep-alive)                                     │
│  ┌─ CapsuleShell (absolute, token-positioned) ────────┐ │
│  │  InputComposer  OR  CommandsComposer (App mode)    │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### InputComposer — `flat`

```text
[ leading tools … ] [ ghost textarea ] [ trailing tools … Send ]
```

### InputComposer — `stacked`

```text
[ ghost textarea — full shell content width ]
[ leading tools …              trailing tools … Send ]
```

### CommandsComposer (primarily App)

```text
[ mode toggle ] [ phys key row … ] [ overflow popover ]
```

| Part | Role |
|------|------|
| CapsuleShell | Float inside well; safe-area + experience shell tokens |
| Ghost textarea | Command compose; history ghost + Tab accept |
| Leading / trailing tool clusters | History, Commands (Web Input), Paste, Copy, Send; App adds mode toggle on leading |
| CommandsComposer | Quick keys when `mode === commands`; no flat/stacked layout machine |

## States

Capsule UI reflects **client input mode**, not Agent/Session/attachment lifecycle. ConnectionStatus lives in [SessionHeader](session-header.md).

| State | Behavior |
|-------|----------|
| `disabled` | No input; tools inert; layout frozen |
| `mode: input` | InputComposer; flat ↔ stacked from content line count |
| `mode: commands` | CommandsComposer (App); Input layout machine inactive |
| `composerLayout: flat` | Single-row strip |
| `composerLayout: stacked` | Full-width field row + toolbar row |
| Popover open | History or Commands (mutually exclusive) |
| Empty after send | flat; close open popovers |

**Frozen input semantics (implementation must preserve):** Enter send; Shift+Enter newline; ghost + Tab; IME suppresses ghost; send clears value and closes History/Commands popovers.

## Tokens

| Part | Token ids |
|------|-----------|
| Capsule surface | `domain.terminal.capsuleSurface` |
| Well behind xterm | `domain.terminal.wellBackground` (xterm Catppuccin — independent of Zinc chrome) |
| Control height Web | `experience.web.control.md` |
| Control height App | `experience.app.control.md` |
| Touch target App | `experience.app.touchTarget.min` |
| Composer line height | `experience.*.composer.lineHeight` |
| Max input lines | `experience.*.composer.maxLines` |
| Shell max width Web | `experience.web.composer.shellMaxWidth` |
| Shell inset App | `experience.app.composer.shellInset` |
| Shell safe area App | `experience.app.composer.shellSafeArea` |
| Shell radius | `semantic.radius.capsule` |
| Composer motion | `experience.*.motion.composer` |
| Borders / popover chrome | Semantic `border`, `popover`, `foreground`, `muted` |

Components consume generated CSS vars only. No `--sf-*` metrics, no TS `*_PX` constants, no Tailwind numeric size scale for control metrics.

## Web vs App

| | Web | App |
|--|-----|-----|
| Experience attr | `[data-experience="web"]` | `[data-experience="app"]` |
| State | **Same** `useCapsuleState` | **Same** |
| Shell | Centered; `experience.web.composer.shellMaxWidth` | Inset; `shellInset` + `shellSafeArea` |
| Input controls | History, Commands, Paste, Copy, Send | Mode toggle, History, Paste, Copy, Send (Commands via mode) |
| Commands mode | Not default path | PhysKey row + overflow |
| flat / stacked | Yes | Yes (same line-count rules) |
| Control tokens | `experience.web.control.*` | `experience.app.control.*` (remapped under App scope) |

Presentation differs by **experience config** (token ids + control visibility). Do not fork state. Do not use viewport breakpoints + a second hardcoded size scale.

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and canonical Terminal screens ([#563](https://github.com/BestNathan/nession/pull/563), [#568](https://github.com/BestNathan/nession/pull/568)).

### Dominance

- Capsule is a **floating control surface** — reachable and legible, but **must not outshine xterm output** (P1: Terminal dominates).
- Send is the one **primary action** in the capsule region (P4); tool buttons are secondary/ghost.

### Information hierarchy

- **Primary:** ghost textarea compose buffer (when focused) or phys-key intent (Commands mode).
- **Secondary:** Send, mode toggle (App).
- **Tertiary:** History, Paste, Copy, overflow — progressively disclosed via icons/menus.

### Alignment

- Web: centered pill with max width — docked to bottom of well, not shell viewport.
- App: full-width inset respecting safe-area; stacked layout puts field row above toolbar row.

### Density

- **Floating controls / compact** — single-line capsule when empty (`flat`); grows to `stacked` only when content requires ([visual-language.md](../../visual-language.md) §4).
- Does not expand vertically with terminal scrollback.

### Whitespace

- Clearance gap between xterm last row and capsule top — dynamic `--terminal-capsule-clearance` owned by [TerminalSurface](terminal-surface.md).
- Internal tool clusters separated by whitespace, not nested cards.

### Contrast

- Capsule surface: elevation over terminal well — **only** floating-control elevation in the Terminal region (R-S5 exception).
- Compose field: readable against `domain.terminal.capsuleSurface`; not full `text.primary` chrome scale.

### Surface treatment

- Elevation (shadow) without border stack — floating control surface per visual-language §3.
- `semantic.radius.capsule` — contained radius; not a full-width header bar.

### State-driven emphasis

| State | Emphasis |
|-------|----------|
| Empty, attached | `flat` — minimal vertical footprint |
| Multi-line compose | `stacked` — field row primary; tools secondary row |
| `disabled` / not attached | Inert, frozen layout — no fake "send" prominence |
| Popover open | Popover elevated; dock geometry unchanged |

Connection lifecycle is **not** encoded in capsule color — banner/header own that.

### Anti-patterns

- Chat-bubble transcript UI or streaming markdown in the capsule.
- Capsule taller than necessary when content is empty (permanent stacked chrome).
- Raw Tailwind numeric sizes or `--sf-*` in capsule path.
- Multiple primary-colored buttons (Send + another CTA).
- Workspace/Session navigation controls inside the capsule.

### Canonical reference

- Web: `/#/fixture` 1440×900 — capsule docked in terminal well ([#563](https://github.com/BestNathan/nession/pull/563)).
- App: `/#/fixture/app` 390×844 — inset capsule + Commands mode ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Pattern lives on session-first Terminal path only; legacy BottomBar unchanged.
- [ ] § Frozen input semantics preserved (see States).
- [ ] stacked: input row spans full shell content width (`Contract: pattern.terminal-capsule`).
- [ ] flat: single-row strip; empty content → flat.
- [ ] Token ids only in TS/CSS; capsule path free of overlay metrics and numeric TS layout constants.
- [ ] Web and App share one state machine; `[data-experience]` drives token remap.
- [ ] Playwright: Web desktop + App viewport matrix entry ([#547](https://github.com/BestNathan/nession/issues/547)).

**Contract:** `design/contracts/patterns/terminal-capsule.json` ([#545](https://github.com/BestNathan/nession/issues/545))

**Parent surface:** Input clearance and viewport padding are owned by [TerminalSurface](terminal-surface.md), not duplicated here.

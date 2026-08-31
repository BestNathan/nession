# Terminal Capsule Redesign

**Date:** 2026-08-31  
**Status:** Approved  
**Parent:** [#492](https://github.com/BestNathan/nession/issues/492) (session-first shell)  
**Supersedes:** V3 capsule sheet UX in [`2026-08-28-session-first-chatgpt-shell-v3-design.md`](./2026-08-28-session-first-chatgpt-shell-v3-design.md) — collapsed pill + light sheet above pill is **removed**  
**Depends on:** Session-first on `staging` (`TerminalCapsule`, full-bleed `TerminalWell`)

---

## Goal

Replace the session-first **TerminalCapsule** interaction with a capsule-native UI/UX. Abandon embedding legacy `InputPanel` / `QuickCommandsPanel` in an expandable sheet. Preserve **full command capabilities** via new surfaces that reuse existing hooks and send semantics.

---

## Problems with current capsule (V3)

- Collapsed pill + `+` opens a **light sheet** (`terminal-capsule-sheet`) that mounts entire legacy panels — visually disconnected from the dark well and duplicates BottomBar UX poorly.
- Input mode requires explicit expand before typing.
- Desktop and mobile share the same Input | Commands mode chrome even though desktop has a physical keyboard.

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Legacy panels in capsule path | **Do not render** `InputPanel` / `QuickCommandsPanel` in capsule; reuse hooks only |
| Sheet / expand popup | **Removed** — no `terminal-capsule-sheet`, no light floating panel above pill |
| Desktop Commands | **No Commands mode** — `Commands` toolbar button opens Popover (no physical keys) |
| Desktop physical keys | **None** (option A) — rely on hardware keyboard |
| Mobile layout | **Single-row dock** always in Commands mode; Input multi-line may grow dock height |
| Mobile mode switch | **Icon toggle** only (Input vs Commands), no text tabs |
| Mobile Commands row | Single row of **quick physical keys**; full keys + command list in **Popover** via `⋯` |
| History | **Hidden by default**; toolbar button opens Popover (desktop + mobile Input) |
| Inline completion | History **ghost suffix** + **Tab** to accept; IME composing disables ghost/Tab |
| Scope | Session-first capsule path only; legacy `BottomBar` unchanged |
| Flag | `session_first` default stays off |

---

## Visual language

- Dock sits inside `TerminalWell`, `absolute` bottom, `inset-x` + safe-area (unchanged positioning tokens).
- Background: dark glass on well — e.g. `bg-[var(--sf-terminal-well)]/95`, `border-t border-white/10`, **`rounded-t-2xl`** (top only; bottom flush with well).
- Popovers: same dark family, max-height ~45vh, internal scroll — **not** legacy `bg-background/95` sheet.
- Motion: 150–250ms height/opacity; respect `prefers-reduced-motion`.
- Touch: primary controls ≥44px under `max-lg`.

---

## Architecture

```
session-first/capsule/
├── TerminalCapsule.tsx       # shell: layout, disabled, popover mutual exclusion
├── CapsuleModeToggle.tsx     # mobile icon toggle
├── CapsuleInputRow.tsx       # input + ghost + actions
├── CapsuleCommandsRow.tsx    # mobile quick phys keys
├── CapsuleHistoryPopover.tsx
├── CapsuleCommandsPopover.tsx  # desktop + mobile (props: showPhysKeys)
├── CapsuleGhostInput.tsx     # ghost overlay + Tab accept
├── useHistoryGhost.ts        # prefix match from useCommandHistory
├── useCapsuleCommands.ts     # chain/send/presets (extracted from QuickCommandsPanel)
└── types.ts                  # CapsuleMode, popover ids
```

**TerminalCapsule props (new):**

```ts
interface TerminalCapsuleProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  /** mobile only — undefined on desktop (no mode switch) */
  mode?: CapsuleMode;
  onModeChange?: (mode: CapsuleMode) => void;
}
```

Remove: `expanded`, `onExpandedChange`, `inputPanel`, `commandsPanel`.

---

## Desktop UX

### Input bar (only surface)

```
[ input + ghost …                    ] [Send][Paste][Copy?][History][Commands]
```

| Control | Behavior |
|---------|----------|
| Input | Click focuses immediately; single row default |
| Ghost | Dim suffix from newest history entry where `command.startsWith(value)`; hidden when empty or composing |
| Tab | Accept ghost suffix into value |
| Send | `trim + '\r'`, `addEntry` |
| Paste / Copy | Same semantics as `InputPanel` |
| History | Opens `CapsuleHistoryPopover` — searchable list, pick fills input |
| Commands | Opens `CapsuleCommandsPopover` (`showPhysKeys=false`) — presets, user cmds, add/delete, **no phys keys** |

**Multi-line growth:** When textarea content wraps to ≥2 lines (Shift+Enter or soft wrap at dock width), dock **height grows in place** (max ~4 lines then internal scroll). Collapse back to single row when content returns to one line.

**Popover rules:** History and Commands popovers are **mutually exclusive**. Click outside or Esc closes focused popover.

---

## Mobile UX

### Shell (both modes)

```
[icon toggle] | … single-row center … | [actions]
```

- **Mode toggle:** two icon buttons (Input / Commands), ToggleGroup pattern, persists last mode in component state (parent owns state like today).
- Dock height: **fixed single row** except Input multi-line growth (same rule as desktop).

### Input mode

```
[✎●⌨] | [ input + ghost … ] | [Send][History]
```

- History via button → same `CapsuleHistoryPopover` as desktop.
- No Commands button (switch mode instead).

### Commands mode

```
[✎⌨●] | Esc Tab Space Enter Ctrl+C … | [⋯]
```

| Control | Behavior |
|---------|----------|
| Quick keys | One horizontal row; highest-frequency keys; tap sends |
| Long-press key | Chain mode (400ms, same semantics as `QuickCommandsPanel`) |
| `⋯` | Opens `CapsuleCommandsPopover` (`showPhysKeys=true`) — full KeyRow, preset/user commands, Add dialog, chain bar when active |

Chain active: thin banner **above** the single-row dock (does not replace row); Cancel/Send in banner.

---

## Shared: Commands Popover content

When open (`showPhysKeys` true on mobile, false on desktop):

1. **Chain bar** (conditional)
2. **Physical keys** (mobile only) — full `KeyRow` layout including arrows
3. **Commands** — preset + user list (run, delete user, add via existing dialog pattern)
4. Scroll inside popover; max ~45vh

Logic source: extract from `QuickCommandsPanel` into `useCapsuleCommands` + shared presentational subcomponents where needed (do not import `QuickCommandsPanel`).

---

## Shared: History Popover

- Trigger: History button (desktop Input; mobile Input)
- Filter: `useCommandHistory().filterHistory(query)` — reuse existing hook
- Select row → set input value, close popover
- Optional search field in popover header

---

## Ghost completion spec

| Rule | Detail |
|------|--------|
| Match | `entry.command.startsWith(inputValue)` && `inputValue.length > 0` |
| Pick | Most recent matching entry (hook order) |
| Display | Typed text normal; remainder as muted ghost inline |
| Tab | Append ghost suffix; clear ghost |
| Esc | Clear ghost only |
| IME | No ghost while `isComposing`; Tab ignored |
| a11y | `aria-autocomplete="inline"`, describe Tab hint in tooltip optional |

---

## Files touched (implementation)

| Area | Action |
|------|--------|
| `session-first/capsule/**` | **Create** — new capsule module |
| `session-first/TerminalCapsule.tsx` | **Replace** — thin re-export or delete after move |
| `components/TerminalLayout.tsx` | Wire new props; drop `capsuleExpanded` state |
| `components/MobileTerminalLayout.tsx` | Wire mode + new capsule |
| `session-first/__tests__/integration/TerminalCapsule.test.tsx` | Rewrite |
| `components/__tests__/integration/TerminalLayout.capsule.test.tsx` | Update |
| `components/__tests__/integration/MobileTerminalLayout.test.tsx` | Update |

**Do not touch:** `InputPanel.tsx`, `QuickCommandsPanel.tsx`, legacy BottomBar path, `sessionFirst.ts` default, `k8s/overlays/**`.

---

## Acceptance

- [ ] `?session_first=1` desktop: single input dock; no sheet; Commands/History via popover buttons
- [ ] Desktop Commands popover: presets + user commands + add/delete; **no** physical keys
- [ ] Mobile: icon mode toggle; Commands mode single-row quick keys; `⋯` popover has full keys + commands
- [ ] Ghost + Tab completion from history works; IME safe
- [ ] Input multi-line grows dock in place; Commands mode dock stays single-row
- [ ] `toolbarDisabled` disables entire capsule
- [ ] Legacy Dashboard BottomBar unchanged
- [ ] Unit/integration tests updated; Playwright screenshots on PR comment
- [ ] `just web-lint` / `just web-test` pass

---

## Non-goals

- Redesign legacy BottomBar / `InputPanel` / `QuickCommandsPanel`
- Env / Files in capsule
- Desktop Commands mode toggle
- Changing quick-command server API

---

## Delivery

| Item | Target |
|------|--------|
| Spec | this doc → `main` |
| Implementation | worktree from `origin/staging`; PR → `staging` |
| Tracking | Comment on #492 |

# Capsule Commands — Inline Panel (Mobile App)

**Date:** 2026-09-07  
**Status:** Implemented  
**Parent:** [terminal-capsule.md](../../design/design-system/patterns/terminal-capsule.md), [#492](https://github.com/BestNathan/nession/issues/492)  
**Supersedes (App overflow only):** Bottom `Sheet` presentation for `CapsuleCommandsPopover` (`presentation="sheet"`) introduced in PR #643 / #644  
**Builds on:** V4 mobile polish intent ([2026-08-28-session-first-chatgpt-shell-v4-design.md](./2026-08-28-session-first-chatgpt-shell-v4-design.md)) — compact expanded height, xterm stays readable

---

## Problem

On mobile App (`experience="app"`, Commands mode):

1. **Capsule buttons still fail to respond to taps** — quick keys (Esc, Tab, …), mode toggle, and overflow actions remain unreliable after Sheet z-index and `pointerdown preventDefault` fixes (PR #644, staging `4579f2c`).
2. **Overflow menu blocks the terminal** — the three-dots (`More`) path opens a bottom Sheet with a full-viewport overlay and backdrop blur. Users cannot read xterm output behind the panel while choosing a command.
3. **Panel is too tall** — `--composer-popover-max-height` (45vh) dominates the well; V4 targeted ~28vh for mobile readability.

Root causes (confirmed in code review):

| Cause | Effect |
|-------|--------|
| Sheet portal + full-screen `SheetOverlay` (blur + dim) | Terminal visually obscured; overlay intercepts taps when z-index regresses |
| Base UI Dialog `InternalBackdrop` (modal) | Additional invisible full-screen layer |
| Portal stacking separate from `CapsuleShell` (`z-20`) | Fragile z-index; tailwind-merge can drop content z-class |
| Quick keys wrapped in Radix triggers / prior `preventDefault` on pointerdown | Mobile Safari click synthesis blocked |

---

## Goal

Replace App overflow **Sheet** with a **dock-attached inline panel** that:

- Expands upward from the capsule bar — **no blur, no full-screen dim**
- Caps at **20vh**; list scrolls inside
- Keeps terminal **readable** above the panel while open (read-only — user dismisses before typing in xterm)
- **Tap terminal area above the panel** dismisses the panel (does not send keys to tmux)
- Restores reliable taps on quick keys and overflow controls

Web Input overflow (`CapsuleInputTools` → popover) is **unchanged**.

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Interaction while open | **A — read-only visible:** terminal visible; input blocked until panel closed |
| App overflow presentation | **`inline`** — panel inside `CapsuleShell`, no portal |
| Sheet on App | **Remove** — deprecate `presentation="sheet"` for App |
| Web overflow | Keep **`popover`** (anchored, `modal={false}`) |
| Max panel height (App) | **`--composer-commands-panel-max-height: 20vh`** (new token) |
| Backdrop | **None** — no overlay, no blur, no dim |
| Dismiss | ✕ button, More toggle, **tap terminal well above panel**, command run |
| Quick keys row | Always visible in collapsed bar; unchanged labels |
| PhysKeyRow | Inside expanded panel (App) |
| Occlusion | Update `--terminal-capsule-occlusion` to bar + panel height when open |
| Scope | Session-first App Commands mode only; legacy BottomBar untouched |

---

## Architecture

### Component tree (App, Commands mode, panel open)

```text
[data-terminal-capsule-host]
├── xterm viewport (visible above panel; tap-to-dismiss target)
└── CapsuleShell (absolute z-20)
    └── pointer-events-auto column
        ├── CapsuleCommandsDismissLayer (conditional, see Interaction)
        ├── main bar (always)
        │   [CapsuleModeToggle] [CapsuleCommandsRow quick keys] [More]
        └── CapsuleCommandsPanel (conditional, commandsOpen)
            ├── header: title + close
            ├── PhysKeyRow
            ├── scrollable command list
            └── add-command footer
```

### New / changed components

| Component | Role |
|-----------|------|
| **`CapsuleCommandsPanel`** | Inline panel body (extract from `CapsuleCommandsPanelBody` + chrome) |
| **`CapsuleCommandsDismissLayer`** | Fixed/absolute layer covering terminal well **above** the expanded dock; pointer-events auto; visually transparent; `onClick` → `setCommandsOpen(false)` |
| **`CapsuleCommandsPopover`** | Add `presentation: 'inline' \| 'popover'`; App More uses `'inline'`; remove `'sheet'` branch |
| **`CapsuleShell`** | Column flex: optional dismiss layer (portal to host sibling, see below), bar, panel |

### Dismiss layer placement

The dismiss layer must cover the **xterm area above the capsule**, not the panel itself.

**Preferred:** Render dismiss layer as a **sibling inside `[data-terminal-capsule-host]`**, positioned `absolute inset-0` with `bottom` set to the measured dock height (bar + panel when open). Only mounted when `commandsOpen`. `pointer-events: auto`; `z-index` below capsule bar/panel (`z-10`) but above xterm default stacking for hit-testing.

Capsule bar + panel stay at `z-20` and remain fully interactive.

Alternative (if sibling is awkward): host-level listener in `TerminalCapsule` — only if dismiss layer proves hard to measure; prefer explicit layer for testability.

---

## Interaction spec

| User action | Result |
|-------------|--------|
| Tap quick key (Esc, Tab, …) | Send phys seq via `onClick`; panel state unchanged |
| Tap More | Toggle `commandsOpen` |
| Tap ✕ or run a command | Close panel; command sends on run |
| Tap/swipe terminal area **above** expanded dock | Close panel only — **no** keystrokes to tmux |
| Panel open | xterm readable; IME / tap-to-focus on terminal disabled until close |
| Add command | Close panel → open existing add-command dialog (unchanged) |

**No** `onPointerDown preventDefault` on capsule buttons. App surfaces keep `showTooltips={false}`.

---

## Visual spec

| Property | Value |
|----------|--------|
| Panel max height | `max-h-[length:var(--composer-commands-panel-max-height)]` → **20vh** on App |
| List area | `flex-1 min-h-0 overflow-y-auto` inside panel |
| Background | `bg-popover` solid; **no** `backdrop-blur`, **no** overlay tint |
| Border | `border-t border-border/60` between bar and panel |
| Top radius | `rounded-t-xl` on panel top edge |
| Motion | Slide up ~150ms; respect `prefers-reduced-motion: reduce` |
| Main bar | Height unchanged; stays bottom-anchored |

### Tokens (design source)

Add under `[data-experience="app"]` in `design/tokens` (same pipeline as other `experience.app.composer.*` ids):

- **Token id:** `experience.app.composer.commandsPanelMaxHeight`
- **Generated CSS var:** `--composer-commands-panel-max-height: 20vh`

Do **not** reuse `--composer-popover-max-height` (45vh) for the inline panel.

---

## Occlusion sync

When `commandsOpen`:

1. Measure dock ref total height (bar + panel).
2. Set `--terminal-capsule-occlusion` on `[data-terminal-capsule-host]`.
3. `CapsuleOcclusionScroll` keeps live output above the band.

When closed: occlusion = bar height only (commands mode single-row shell).

---

## Migration / cleanup

| Item | Action |
|------|--------|
| `presentation="sheet"` in `CapsuleCommandsPopover` | Remove branch |
| `CapsuleCommandsRow` | Pass `presentation="inline"` |
| `capsuleSheetOverlayClass` / `capsuleSheetContentClass` | Remove if unused elsewhere |
| `index.css` sheet z-index overrides for capsule | Remove if unused |
| Tests expecting `[data-slot="sheet-content"]` | Rewrite for inline panel + dismiss layer |

---

## Testing

### Unit / integration (Vitest)

- More opens → `[data-testid="capsule-commands-panel"]` visible; **no** `sheet-overlay` in DOM
- Quick keys fire `sendText` on `click`
- Dismiss layer click → `commandsOpen` false; **no** `sendText`
- Panel root height ≤ 20vh (computed style or token class present)
- Occlusion CSS variable increases when panel opens

### Visual (staging Playwright MCP)

- Commands mode: terminal text visible above 20vh panel
- No blur on well
- Screenshot: panel open + tap dismiss

### Regression guards

- Web Input commands popover still popover
- History popover unchanged
- `composerTokens.test.tsx` pointer-events pattern preserved on shell

---

## Out of scope

- Changing Input mode flat/stacked layout
- Web Commands mode (not default App path)
- Lowering quick-key touch targets below `--control-md` (44px App)
- Simultaneous terminal input while panel open (option B)

---

## Success criteria

- [ ] All quick keys and More respond on first tap on iOS Safari / Android Chrome (staging)
- [ ] Expanded panel ≤ 20vh; terminal content above panel readable without blur
- [ ] Tap terminal area above panel closes menu without sending keys
- [ ] No full-viewport overlay or backdrop-blur in App commands overflow path

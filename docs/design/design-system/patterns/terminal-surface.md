# Terminal Surface

Primary interactive work area inside an active Session. Renders remote tmux output via xterm.js and routes user input to the PTY.

**Parent:** [product-model.md](../../product-model.md) (Terminal), [interaction/web.md](../../interaction/web.md), [interaction/app.md](../../interaction/app.md)
**Companion pattern:** [TerminalCapsule](terminal-capsule.md) (floating composer chrome)
**Migration / as-built:** [migration.md](../../migration.md) — legacy BottomBar and Agent-first FileTabs paths

## Purpose

- Keep the user in a **real terminal** — workload-agnostic, not a chat transcript UI.
- Maximize usable viewport for program output while keeping compose/send reachable.
- Preserve tmux/tty semantics: keyboard shortcuts, selection, scrollback, control sequences.

Must **not** host Session navigation, Workspace tools, Env editor, or file browsing. Those live in shell chrome or Workspace ([workspace.md](../../workspace.md)).

Connection lifecycle presentation uses [ConnectionStatus](connection-status.md) / [SessionHeader](session-header.md), not terminal-local badges alone.

## Anatomy

```text
┌─ Terminal well (data-terminal-capsule-host on session-first path) ────────┐
│  TerminalBanner          ← attach / reconnect / P2P / relay messaging     │
│  ┌─ TerminalViewport (data-terminal-viewport) — full well height ──────┐ │
│  │  xterm.js grid (Catppuccin; independent of Zinc UI chrome)          │ │
│  │  scrollback may pass under capsule (ChatGPT-style overlay)          │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│  ::after fade ← --terminal-capsule-occlusion (visual only)               │
│  [ App only: TerminalScrollOverlay — page up/down / jump to bottom ]    │
│  ┌─ TerminalCapsule (absolute dock, z-10) ─────────────────────────────┐ │
│  │  InputComposer  |  CommandsComposer (App)                           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

| Part | Role |
|------|------|
| **Well** | Relative container; hosts viewport + floating capsule; publishes occlusion CSS var |
| **TerminalBanner** | Non-blocking connection / attach / mode-switch messaging above viewport |
| **TerminalViewport** | Mount point for xterm; **full well height** — no padding-bottom inset for capsule |
| **xterm instance** | Stable for session attach lifetime; keep-alive when shell hides surface (CSS), not unmount |
| **TerminalScrollOverlay** | App-only touch scroll accelerators; positioned above capsule via occlusion var |
| **TerminalCapsule** | Secondary input plane; see [terminal-capsule.md](terminal-capsule.md) |

## Input planes

Three planes, strict priority:

```text
1. xterm direct  — keyboard (Web) or Mobile IME (App touch)
2. Capsule compose — ghost textarea + Send / quick keys
3. Toolbar legacy — BottomBar / TerminalInputBar on pre-migration paths only
```

| Plane | Sends via | Typical use |
|-------|-----------|---------------|
| **xterm direct** | `TerminalInputHandler` → transport | vim, shell, TUI, tmux prefix, paste into PTY |
| **Capsule compose** | `sendText` → `controller.handleInput` | Long commands, history, paste buffer, phys keys (App) |
| **Legacy toolbar** | Same as capsule | Agent-first dashboard until session-first migration completes |

**Rule:** Capsule Enter **always sends** compose buffer to PTY (`\r` appended per frozen capsule semantics). It does **not** forward Enter to xterm while the ghost textarea is focused.

**Rule:** When `toolbarDisabled` (not `attached`), all planes are inert; xterm may still render scrollback from buffer.

## Focus model

### Web

| User action | Focus target | PTY receives |
|-------------|--------------|--------------|
| Click / tab into viewport | xterm | Physical keyboard |
| Click capsule field | Ghost textarea | Nothing until Send |
| Click outside both | Last focused plane | — |
| Cmd/Ctrl+C with xterm selection | Browser copy | Optional SIGINT if bound in shell (xterm default) |

Desktop shell does **not** install global key handlers that compete with xterm. Ctrl+D from xterm or quick-command may trigger client disconnect policy (product decision: back/disconnect).

### App

| User action | Focus target | PTY receives |
|-------------|--------------|--------------|
| Tap viewport (movement ≤ slop) | Mobile IME hidden textarea | Soft keyboard input |
| Tap capsule field | Ghost textarea | Nothing until Send |
| Scroll overlay `pointerdown` | Keep IME focused (`preventDefault` on overlay chrome only) | — |
| Commands mode | Phys key buttons | Immediate sequences via quickcmd source |

**Rule:** Tap-to-focus opens IME even when capsule is visible. Live output pins above the fake-terminal band; scroll up to read lines that pass under the capsule.

**Rule:** Top-level spatial gestures ([app.md](../../interaction/app.md) — Sessions / Workspace) must not fire from normal terminal scroll regions. Edge activation zones belong in App shell spec, not here.

## Scroll & selection

| Capability | Web | App |
|------------|-----|-----|
| Scrollback | xterm wheel / trackpad | Touch scroll on viewport + overlay page buttons |
| Scrollback limit | `experience.web` profile (e.g. 50k lines) | `experience.app` profile (e.g. 10k lines) |
| Text selection | xterm native drag | xterm native when not scrolling |
| Copy selection | Browser Cmd/Ctrl+C | System copy on selection |
| Copy compose buffer | Capsule / InputPanel copy control | Same |
| Paste to PTY | xterm bracketed paste / browser paste | IME paste handler → transport |
| Paste to compose | Capsule paste → buffer only | Same |

**Future (not blocking capsule):** tmux copy-mode via mouse (`MouseIntentResolver`) — desktop only, explicit opt-in; must not break plain click-to-focus.

**Frozen:** Scrolling the viewport must never dismiss an in-progress IME composition.

## Viewport fit & capsule occlusion

**xterm uses the full well height.** The capsule is a floating overlay. The bottom occlusion band is a **fake terminal** (same background, no live text when pinned to bottom). Scroll margin keeps the live bottom above that band; scrolling up lets history pass under the capsule.

Occlusion height is computed at runtime:

```text
occlusion = max(0, hostBottom − dockTop) + terminalClearanceGap
```

Published on `[data-terminal-capsule-host]` as `--terminal-capsule-occlusion` by `useCapsuleDockClearance`. Consumed by:

- `[data-terminal-capsule-host]::after` — opaque fake-terminal band (visual cover when pinned)
- `CapsuleOcclusionScroll` — scroll margin so live output stops above the band
- `TerminalScrollOverlay` — `bottom` offset so controls sit above the dock

| Trigger | Must recalculate |
|---------|------------------|
| Capsule flat ↔ stacked | Yes |
| App mode input ↔ commands | Yes |
| Soft keyboard / safe-area inset change | Yes |
| Window resize / orientation | Yes |
| Popover open (History / Commands) | No — popovers flip upward; dock geometry unchanged |

When occlusion is `0` (legacy paths without capsule host), viewport and scroll chrome use full well height.

**Anti-pattern:** Padding-bottom on `[data-terminal-viewport]` to reserve capsule space — this shortens the xterm grid and is not the ChatGPT overlay model.

## Connection & attach lifecycle

Independent of capsule layout. Driven by session state machine (`idle` → `connecting` → `connected` → `attached` | `reconnecting` | `failed`).

| State | Terminal surface behavior |
|-------|---------------------------|
| Pre-attach | Banner shows progress; input planes disabled; outbound input/resize buffered |
| `attached` | Input enabled; pending flush to transport |
| Relay loss | Banner + reconnect; preserve xterm buffer when possible |
| P2P wait | Viewport may gate until data channel ready; address selector in header chrome |
| Detach / navigate away | `controller.detach()`; stable controller recreated only on address epoch change |

Relay vs P2P does **not** change interaction model — only latency, banner copy, and header address controls.

## Resize & typography

| Event | Behavior |
|-------|----------|
| Container resize | Local xterm grid sync immediately; PTY resize debounced (~200ms), first fire immediate |
| Surface hidden (Workspace active) | xterm stays mounted; **must** refit on reveal (`fit()` + pending PTY resize) |
| Capsule dock height change | Occlusion recalc only; xterm refit when well size unchanged |
| Font size change | `FontSizeManager` adjusts xterm; PTY resize follows |
| Profile switch (Web ↔ App width) | Target: preserve scrollback where possible; today may remount — see migration |

Initial font size and scrollback come from **experience profile** (`DeviceProfile`), not from breakpoint Tailwind classes.

## Web vs App

| Topic | Web (`experience="web"`) | App (`experience="app"`) |
|-------|--------------------------|---------------------------|
| Shell context | [web.md](../../interaction/web.md) — Terminal surface slot, sidebar navigation | [app.md](../../interaction/app.md) — central work surface in spatial model |
| Primary input | Physical keyboard → xterm | Touch → Mobile IME → xterm |
| Capsule shell | Content-width pill (flat); capped max width | Full-width inset; safe-area bottom |
| Capsule controls | History, Send (Commands via popover on web Input path as configured) | Mode toggle, History, Paste, Copy, Send; Commands row |
| Capsule layout | flat ↔ stacked from line count | Same state machine; field-first stacked presentation |
| Scroll helpers | None (xterm only) | TerminalScrollOverlay |
| Touch targets | `experience.web.control.*` | `experience.app.control.*` + `touchTarget.min` |
| Clearance gap token | `experience.web.composer.terminalClearanceGap` | `experience.app.composer.terminalClearanceGap` |

Presentation differs by **`[data-experience]`** token remap, not by ad hoc breakpoint CSS for control metrics.

## Relationship to TerminalCapsule

- **Terminal Surface** = well + viewport + banners + scroll helpers + occlusion contract.
- **TerminalCapsule** = floating composer inside the well; defers compose semantics to [terminal-capsule.md](terminal-capsule.md).

Do not document compose frozen semantics in two places — capsule spec owns Enter / Shift+Enter / ghost / Tab / IME rules.

## What this pattern must not do

- Collapse Agent / Session / attachment into one terminal banner string.
- Replace xterm with a message list or streaming markdown view.
- Use permanent Terminal \| Files split on Web session-first shell ([web.md](../../interaction/web.md)).
- Encode clearance or control metrics as raw Tailwind numeric classes in terminal code paths.
- Make capsule the only input path on desktop (xterm direct input remains primary).
- Shrink the xterm grid with viewport padding to “make room” for the capsule — use overlay + scroll instead.

## Acceptance

- [ ] Session-first Web path: xterm full well height; capsule spans shell max width; live bottom above fake-terminal band.
- [ ] Session-first App path: same overlay + scroll-margin model; IME tap-to-focus; scroll overlay above dock.
- [ ] At live bottom, newest lines stay above the fake-terminal band; scroll up to read under the capsule.
- [ ] `toolbarDisabled` disables capsule and quick keys; xterm scrollback still readable.
- [ ] Workspace surface switch refits xterm on return (no zero-size or clipped grid).
- [ ] Relay and P2P attach paths share the same input/focus rules.
- [ ] Experience tokens drive font/scrollback/control sizes — no second magic scale in terminal/.
- [ ] Playwright matrix: Web desktop + App viewport ([#547](https://github.com/BestNathan/nession/issues/547)) — attach, type in xterm, type in capsule, scroll, soft keyboard clearance.

**Contract (future):** `design/contracts/patterns/terminal-surface.json` — occlusion min gap, host/viewport data attributes, attached gating.

## References

| Doc | Scope |
|-----|-------|
| [terminal-capsule.md](terminal-capsule.md) | Composer anatomy, flat/stacked, tokens |
| [interaction/web.md](../../interaction/web.md) | Where Terminal sits in Web shell |
| [interaction/app.md](../../interaction/app.md) | Spatial model around Terminal |
| `docs/superpowers/specs/2026-08-16-terminal-pc-mobile-architecture-separation-design.md` | Historical IME / desktop split rationale |
| `docs/superpowers/specs/2026-08-11-terminal-session-state-machine-design.md` | Attach state machine detail |

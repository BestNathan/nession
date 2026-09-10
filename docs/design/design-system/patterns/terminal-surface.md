# Terminal Surface

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [interaction](../../interaction/)

Terminal Surface is the primary live work area inside the current Session implementation. It renders remote terminal output, preserves PTY/tmux semantics, and hosts lightweight contextual interaction without turning the Terminal into a dashboard.

**Companion:** [TerminalCapsule](terminal-capsule.md)
**Migration context:** [migration.md](../../migration.md)

## Purpose

- Keep the user in a real terminal for shell/TUI workloads.
- Maximize usable viewport and preserve terminal semantics.
- Provide a stable host for contextual interaction surfaces such as TerminalCapsule.
- Surface connectivity/attachment problems only to the degree they affect current work.

Terminal remains the current hero surface, but that does not make every surrounding control permanent product anatomy.

## Anatomy

```text
┌─ Terminal well ───────────────────────────────────────────────┐
│ optional continuity banner / state                           │
│ ┌─ TerminalViewport ────────────────────────────────────────┐ │
│ │ xterm.js / current terminal workload                     │ │
│ │                                                          │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                             │
│        ┌─ TerminalCapsule ──────────────────────────┐        │
│        │ intent / input / contextual capability    │        │
│        └───────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

| Part | Role |
|------|------|
| Terminal well | Stable host for viewport + contextual floating layers |
| TerminalViewport | xterm mount point and scrollback owner |
| continuity/banner state | Local attach/reconnect/mode messaging when necessary |
| TerminalCapsule | Conversational/contextual interaction surface; see its own pattern spec |
| App scroll helpers | Touch-specific accelerators when required |

## Input planes

Nession can support multiple input planes without forcing them into one semantic mode:

1. **xterm direct** — physical keyboard / terminal-native input to PTY;
2. **terminal compose mode** — explicit composed terminal text/commands sent to PTY;
3. **conversational / contextual capsule mode** — high-level intent and capability interactions that may or may not map directly to raw PTY input.

The Terminal Surface owns transport-safe delivery for terminal input. The TerminalCapsule owns the high-level interaction semantics.

Do **not** freeze “Capsule Enter always sends `\r` to PTY” as a universal product rule. That behavior is valid only when the capsule is explicitly in a terminal-input mode. A conversational/contextual mode may route through a capability, command, or other Nession interaction path.

## Focus model

### Web

- Clicking/focusing xterm routes physical keyboard input to the terminal.
- Clicking the capsule transfers focus to the capsule without destroying xterm state.
- Global keyboard handlers must not steal terminal-native shortcuts while xterm owns focus.
- Opening contextual capability UI must preserve the same Session and terminal buffer.

### App

- Tapping the viewport may focus the mobile terminal IME.
- Tapping the capsule focuses the capsule interaction plane.
- Touch scroll helpers should preserve appropriate IME/focus state.
- Top-level Sessions/Workspace gestures must not fire from ordinary terminal scroll intent.

Exact keyboard/IME mechanics remain implementation-specific and should be protected by tests/contracts where stable.

## Scroll, selection, and occlusion

Terminal scrollback remains owned by xterm. A floating capsule may visually overlap the bottom region without permanently shrinking the terminal grid.

The current overlay model may compute an occlusion band from capsule geometry:

```text
occlusion = max(0, hostBottom - dockTop) + terminalClearanceGap
```

This can drive:

- visual cover/fade for the live-bottom region;
- scroll margin so newest output remains readable;
- App scroll-helper placement;
- safe-area/keyboard clearance.

The exact CSS variable/hooks are implementation details. The product invariant is that contextual chrome should not permanently consume more Terminal viewport than necessary.

**Anti-pattern:** reserving a large fixed bottom toolbar region merely because the capsule can expose more capabilities.

## Connection and attachment lifecycle

Connectivity remains independent from capsule/product layout.

Keep at least these dimensions separate:

```text
Agent / Workspace Location connectivity
Session lifecycle
client attachment
```

A reconnecting Agent must not be mislabeled as an exited Session. An active Session with a detached client must not be presented as destroyed.

Local banners or [ConnectionStatus](connection-status.md) may communicate these states when they affect continuity. Healthy transport remains quiet.

## Capability presence

The Terminal Surface does not enumerate capabilities. It only provides room for contextual presence owned by Nession.

```text
unavailable -> available -> relevant -> active
```

- unavailable/merely available capabilities should not create permanent Terminal chrome;
- relevant capability may affect contextual actions;
- active capability may gain lightweight presence around the capsule;
- deeper capability UI opens explicitly as an overlay/panel/sheet or through Workspace contextual depth.

For example, Claude Code becoming active may change capsule presence/actions while the Terminal remains visible and usable.

## Resize and typography

Terminal implementation still needs reliable fit/resize behavior:

- container resize updates local grid and remote PTY dimensions through the existing debounced policy;
- returning from Workspace/deeper surfaces refits the terminal when required;
- capsule geometry changes should prefer occlusion/clearance updates over unnecessary terminal remounts;
- font/scrollback/control metrics come from Experience tokens, not ad-hoc breakpoint values;
- preserve scrollback and controller lifetime across contextual UI transitions where possible.

## Web vs App

| Topic | Web | App |
|-------|-----|-----|
| Direct terminal input | Physical keyboard → xterm | Touch/IME → xterm |
| Capsule | Floating contextual interaction surface | Floating safe-area-aware contextual surface |
| Scroll helpers | Usually xterm native | May include touch accelerators |
| Deeper capability UI | Popover/panel/overlay chosen by Nession | Sheet/overlay/pushed surface chosen by Nession |
| Workspace access | Explicit Web affordance | Visible affordance + swipe-left |
| Metrics | Web Experience tokens | App Experience/touch tokens |

Presentation may differ; capability/session semantics do not.

## Relationship to TerminalCapsule

- **Terminal Surface** owns the live terminal well, viewport, terminal focus/scroll, attach lifecycle, and safe hosting of overlays.
- **TerminalCapsule** owns conversational/contextual intent, explicit expansion, capability presence, and terminal compose semantics when that mode is selected.

Do not duplicate capsule interaction rules here. See [terminal-capsule.md](terminal-capsule.md).

## What this pattern must not do

- Replace xterm with a chat transcript for ordinary terminal workloads.
- Treat “terminal workload agnostic” as a reason Nession cannot understand an active capability.
- Hard-code one capsule mode as universal behavior.
- Collapse Agent/location, Session, and attachment status into one state.
- Add permanent feature/tool chrome around Terminal as capability count grows.
- Force Files or Workspace into a permanent Terminal split.
- Shrink the terminal grid with large fixed padding to reserve hypothetical UI.
- Let extension-specific UI redefine the global Terminal shell.

## Executable-contract migration

Existing terminal contracts and fixtures may encode the current PTY compose behavior, capsule geometry, and SurfaceSwitcher/Workspace interactions. Keep those constraints until the corresponding runtime behavior changes, but treat them as implementation state rather than upstream product truth.

When changing behavior:

```text
product / interaction decision
    ↓
TerminalSurface + TerminalCapsule specs
    ↓
implementation
    ↓
contracts / fixtures / visual baseline
```

Update the lower layers together.

## Acceptance for future implementation work

- [ ] xterm remains reliable and receives maximum practical work area.
- [ ] terminal-native input continues to preserve PTY/TUI semantics.
- [ ] capsule terminal-input mode and conversational/contextual mode are not conflated.
- [ ] active capability can gain lightweight presence without replacing Terminal.
- [ ] deeper capability UI preserves Session/terminal continuity.
- [ ] Workspace transitions return to a correctly fitted terminal.
- [ ] healthy infrastructure does not create unnecessary chrome.
- [ ] Web/App use experience-specific presentation while sharing product semantics.

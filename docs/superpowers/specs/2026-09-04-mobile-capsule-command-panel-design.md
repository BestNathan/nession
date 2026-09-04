# Mobile Capsule Command Panel Design

## Goal

Redesign the mobile TerminalCapsule command panel so quick commands remain easy to discover and operate without taking over or blurring the terminal surface.

## Scope

### In scope

- Mobile `TerminalCapsule` command mode and the three-dots overflow trigger.
- Anchored command-panel layout, sizing, scrolling, focus, dismissal, and touch behavior.
- Presentation reuse between mobile and desktop without changing command semantics.
- Regression coverage for mobile layout and interaction behavior.

### Out of scope

- The terminal transport, `SessionRuntime`, or command persistence API.
- The legacy `BottomBar` command UI.
- Redesigning the command editor fields or changing the quick-command data model.

## Design Principles

- Terminal output remains the primary surface.
- The command panel is a temporary anchored tool, not a full-screen navigation state.
- All interactive controls remain usable with touch, keyboard, and assistive technology.
- The existing physical-key, command, custom-command, and chaining semantics remain intact.

## Layout

The mobile three-dots trigger opens an anchored popover above the trigger. It uses the available viewport width minus safe horizontal insets and a token-defined maximum height of approximately 40–45% of the viewport.

```text
[ Esc ] [ Tab ] [ Shift ] [ Space ] [ Enter ] [ … ]
                       ┌────────────────────────┐
                       │ Quick keys              │
                       │ Esc Tab Shift Space ... │
                       ├────────────────────────┤
                       │ Built-in commands       │
                       │ Ctrl+C                  │
                       │ Ctrl+D                  │
                       │ Ctrl+L                  │
                       ├────────────────────────┤
                       │ Custom commands         │
                       │ My command              │
                       ├────────────────────────┤
                       │ + Add command           │
                       └────────────────────────┘
```

- The popover is aligned to the overflow trigger and flips direction when the viewport has insufficient space above it.
- The panel surface is opaque and elevated with semantic tokens; it has no `backdrop-filter` blur.
- There is no visual full-screen scrim. The outside-click layer only dismisses the panel and does not obscure terminal output.
- The physical-key row is horizontally scrollable when needed; the command list is independently vertically scrollable.
- The add-command action stays fixed at the bottom of the panel.
- Safe-area insets and a minimum 44px touch target apply to all controls.

## Interaction

- Tapping the three-dots trigger opens the panel and exposes an active/expanded state to assistive technology.
- Tapping a physical key or command sends exactly one input, closes the panel, and returns focus to the terminal.
- Long-press and chained physical-key behavior remain unchanged.
- Tapping `Add command` opens the existing command editor dialog without navigating away.
- Tapping outside, pressing `Escape`, or using the platform back gesture closes the panel without changing terminal state.
- The panel does not lock terminal scrolling or replace the terminal focus model while open.
- Open and close transitions use the existing motion tokens and are disabled under `prefers-reduced-motion`.
- Pressed, focused, disabled, and selected states remain visible in both light and dark themes.

## Component and State Design

- Keep `useCapsuleCommands` as the source of command data and send behavior.
- Keep `commandsOpen` in the existing capsule state; do not introduce a second overlay state machine.
- Keep `CapsuleCommandsPanelBody` as the shared content layer.
- Use the Base UI popover primitive for the mobile anchored presentation instead of the full-screen Sheet primitive.
- Keep desktop Popover behavior compatible, with mobile and desktop differences expressed through responsive/tokenized sizing and positioning.
- Wrap command execution at the presentation boundary so successful command/key actions close the panel while the underlying send and history behavior remains unchanged.
- Keep the existing command editor Dialog and persistence hooks unchanged.

## Responsive and Accessibility Requirements

- At 375px viewport width, the panel must fit without horizontal page overflow.
- Portrait and landscape layouts must preserve the trigger, panel, safe-area padding, and independent scroll regions.
- No content may be hidden behind the bottom system gesture area.
- The trigger has an accessible name and exposes expanded state.
- Focus is visible for every panel control; icon-only controls retain accessible labels.
- Text and control contrast must remain readable in light and dark modes.
- The panel must remain operable with keyboard navigation and screen readers.

## Verification

- Integration tests cover mobile anchored presentation, absence of Sheet/backdrop blur, quick-key and command execution, add-command dialog, dismissal, and focus/expanded state.
- Existing desktop Popover and legacy BottomBar tests remain unchanged or pass without behavior changes.
- Run the web test suite, lint, and production build.
- Perform a browser smoke check at 375px portrait and a landscape viewport, including opening the panel, scrolling commands, executing a command, and dismissing it.


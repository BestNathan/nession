# Mobile Capsule Full Physical-Key Panel

## Context

The compact mobile capsule intentionally shows only the most common physical
keys. The expanded command panel must be a complete mobile terminal control
surface. The current redesign incorrectly moved uncommon keys and arrow keys
behind an overflow menu, removing the previously available full keyboard
layout and weakening chained-key input.

## Goals

- Keep the collapsed capsule limited to `QUICK_MOBILE_KEYS`.
- Restore the expanded physical-key area with all `LEFT_KEYS` and `ARROW_KEYS`
  directly visible.
- Preserve the original layout relationship: left keys in a 5-by-2 grid and
  arrow keys in a T-shaped 3-by-2 grid.
- Keep the physical-key area and the command list as two equally prominent
  sections of the expanded panel.
- Preserve pointer, long-press, chaining, disabled, keyboard, and touch
  behavior for every physical key.
- Keep the shared Popover presentation, shared command hook, and terminal /
  WebSocket infrastructure unchanged.

## Non-goals

- No changes to the collapsed capsule's quick-key set or its layout.
- No changes to command persistence, command data, transport, or terminal
  runtime behavior.
- No new physical-key overflow menu.
- No changes to the generic Sheet component or unrelated command consumers.

## UX and layout

The expanded Popover remains anchored above the More trigger and keeps the
terminal visible without a scrim or backdrop blur.

The panel body is vertically structured:

1. Optional chain bar.
2. Complete physical-key section with a visible separator:
   - left keys: Esc, Tab, Shift, Space, Enter, Del, Home, PgUp, PgDn, End;
   - arrow keys: ↑, ←, ↓, → in the existing T-shaped arrangement.
3. Scrollable quick-command list.
4. Fixed add-command footer and dialog entry point.

The physical-key section uses tokenized spacing and touch-sized buttons. The
panel may scroll its command list on narrow or short viewports, but no key is
hidden behind an overflow affordance.

## Architecture

- `CapsuleCommandsRow` remains the collapsed mobile capsule surface and keeps
  using `QUICK_MOBILE_KEYS`.
- `PhysKeyRow` becomes the expanded complete-key surface and renders
  `LEFT_KEYS` plus `ARROW_KEYS` directly.
- The existing `KeyButton` interaction implementation remains the single
  implementation for visible physical keys, including arrow keys.
- `CapsuleCommandsPopover` continues to own presentation-level dismissal
  after command, physical-key, and chain-send actions.

## Verification

- Assert the collapsed row still renders only the common quick keys.
- Assert the expanded panel renders all 10 left keys and all 4 arrows, with no
  overflow trigger.
- Assert visible arrow execution sends exactly once and closes the panel.
- Keep long-press chain coverage and assert an arrow can participate in a
  chain.
- Run focused capsule tests, the complete web test suite, lint, build, token
  checks, and diff checks.


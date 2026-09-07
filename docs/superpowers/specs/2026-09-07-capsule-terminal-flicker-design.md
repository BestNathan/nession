# App Capsule Resize Terminal Flicker Design

## Goal

Prevent the terminal from visibly flashing when the App capsule changes height,
while preserving the capsule occlusion band and local scrollback behavior.

## Root cause

The capsule publishes its current occlusion height through
`--terminal-capsule-occlusion`. While following live output,
`CapsuleOcclusionScroll` maps that value to
`--terminal-content-bottom-inset`. `TerminalViewport` currently applies the
inset as `padding-bottom`, which changes the xterm mount element's content
height every time the capsule grows, shrinks, or animates. The terminal's
`ResizeObserver` then recalculates rows and repaints repeatedly, producing a
visible flash.

The CSS already provides a fake-terminal background band through the host's
`::after` pseudo-element. The terminal viewport should therefore remain full
height and allow scrollback to pass underneath the floating capsule.

## Design

1. Remove the dynamic `paddingBottom` style from `TerminalViewport`.
2. Keep `--terminal-content-bottom-inset` as a visual-only value consumed by
   the terminal host's fake-terminal band and scroll-control positioning.
3. Keep the existing xterm resize observer unchanged for real terminal-well
   size changes; those changes still need to update the local grid and PTY.
4. Update the viewport regression test to assert that capsule occlusion does
   not alter the xterm mount element's inline layout.
5. Keep the change scoped to the viewport/occlusion boundary; no protocol or
   transport behavior changes are needed.

## Acceptance criteria

- App capsule flat/stacked height changes do not modify the xterm viewport's
  layout height.
- `TerminalViewport` remains mounted and does not detach/re-attach the
  controller during capsule layout changes.
- The capsule occlusion band still uses the published CSS variable.
- Existing terminal, capsule, scrollback, typecheck, lint, and build checks
  remain green.

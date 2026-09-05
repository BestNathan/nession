# Mobile Capsule Physical-Key Layout Design

## Goal

Improve the expanded mobile terminal command panel so the physical shortcut keys and arrow cluster are presented as equal, usable controls without overlap, while reducing the oversized visual weight of mobile text and icons.

## Layout

- Keep the physical shortcut key group and arrow-key group on one horizontal row.
- Give the shortcut group the flexible left-side space and keep the arrow cluster at a fixed intrinsic width on the right.
- Preserve five equal shortcut columns so labels such as `Space` and `Enter` remain on one line.
- Keep the command list below the physical-key row, separated by the existing divider.
- Constrain the panel to the available mobile viewport width; do not rely on an oversized fixed panel that can overflow horizontally.

## Sizing and visual density

- Retain a minimum visual width of `5ch` for physical-key buttons and `whitespace-nowrap`.
- Preserve the 44px touch/control band while reducing internal visual content and spacing through the existing composer tokens.
- Reduce physical-key row padding, inter-key gaps, font size, and arrow icon size before changing the interactive control band.
- Apply the compact sizing only to the mobile capsule panel; do not change desktop terminal controls.

## Interaction contract

- Clicking a physical key sends the key and keeps the expanded panel open.
- Clicking an arrow key sends the key and keeps the expanded panel open.
- Long-press chaining continues to work for physical and arrow keys.
- Clicking a quick command sends it and closes the panel.

## Validation

- Add or update style tests for the horizontal row, compact token classes, `5ch` minimum width, and no-wrap labels.
- Keep integration tests covering physical-key and arrow-key interactions, including the panel remaining open.
- Run the focused capsule tests, full web test suite, lint, build, and `git diff --check`.

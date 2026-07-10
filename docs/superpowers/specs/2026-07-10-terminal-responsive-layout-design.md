# Terminal Operation Page — Responsive Layout & UI Redesign

**Date:** 2026-07-10
**Status:** Approved (design)
**Scope:** `web/src/components/TerminalView.tsx` and the layout primitives it composes
(`SidePanel`, `FileTabs`, the `BottomBar` sub-component, `TerminalToolbar`).

## Problem

The terminal operation page has a rigid layout that does not adapt to viewport size,
wastes vertical space, and constrains input:

1. **No responsive behavior.** The layout is desktop-only. The file-browser side panel
   always pushes terminal width, and the bottom bar is a fixed block — neither adapts
   to tablet or phone widths.
2. **Fixed bottom bar height.** `BottomBar` is hard-coded to `h-[116px]`
   (`TerminalView.tsx:178`) regardless of content. A Commands tab with 5 preset buttons
   wastes space; the height never shrinks to fit.
3. **Single-line input.** The send box is a one-line `<Input>` (`TerminalToolbar.tsx:95`),
   so multi-line commands can't be composed.

## Goals

- Responsive layout across three breakpoints: mobile `<640px`, tablet `640–1024px`,
  desktop `>1024px`.
- Bottom bar height adapts to its content, capped so the terminal always keeps usable space.
- Multi-line input with a fixed visible height and internal scroll.

## Non-Goals

- User-resizable bottom bar (drag handle). Explicitly rejected — auto-fit + cap is the chosen model.
- New dependencies (no resizable-panel library).
- Changes to the terminal engine, connection layer, or file/env features beyond layout.
- Changing the desktop file-browser side panel behavior (it already pushes width and is resizable).

## Approach

**CSS-only responsive (Tailwind breakpoint utilities).** A single `TerminalView` component
tree drives all three layouts via Tailwind responsive prefixes (`sm:`, `lg:`) plus flex/grid
and `max-h` utilities. No JavaScript breakpoint hook (`matchMedia`) is introduced.

Drawer open/closed state remains React state (as `SidePanel` already is). What CSS controls
per-breakpoint is *whether a panel takes layout width (push) or overlays* and *whether the
bottom content is inline or a bottom sheet*.

### Why CSS-only works here (refit is already handled)

`ViewportManager` runs a `ResizeObserver` on the terminal container
(`web/src/terminal/ViewportManager.ts:27-33`) and calls `fitAddon.fit()` on every size change.
Therefore **any CSS-driven size change refits xterm automatically**: breakpoint flips,
bottom-bar height changes, and the desktop side-panel push all resize the terminal container,
which the observer already watches.

The one case a `ResizeObserver` cannot handle is `display:none → visible` (it reports 0×0 while
hidden). `FileTabs` already covers this via `onTerminalReveal` → `terminalRef.current.refit()`
(`FileTabs.tsx:160-166`, `TerminalView.tsx:128`). No new refit wiring is required.

Consequently, on mobile the file-browser drawer and the bottom sheet **overlay** the terminal
(they do not push/shrink it), so opening them causes no terminal resize churn.

## Detailed Design

### 1. Responsive breakpoint matrix

Breakpoints follow Tailwind defaults: base = mobile `<640px`, `sm:` = tablet `≥640px`,
`lg:` = desktop `≥1024px`.

| Zone | Mobile `<640px` | Tablet `640–1024px` | Desktop `>1024px` |
|---|---|---|---|
| **Header** | condensed: Back + session name; Route selector + mode badge wrap / collapse | full inline | full inline (unchanged) |
| **File browser** | overlay drawer (`fixed`, slides in over terminal, backdrop) | overlay drawer (slides over terminal, no width push) | inline, resizable, pushes width (unchanged) |
| **Terminal** | fills all remaining space | fills remaining (bottom bar inline below) | fills remaining (unchanged) |
| **Bottom bar** | bottom sheet: thin tab strip; expands as overlay drawer over terminal (cap ~70vh) | inline below terminal, auto-height capped (40vh) | inline below terminal, auto-height capped (40vh) |

Implementation notes:

- **Overlay vs. push.** Overlay drawers use `fixed inset-y-0 left-0` with
  `-translate-x-full` (closed) → `translate-x-0` (open). At the breakpoint where the panel
  should push instead (desktop for the file browser), a `lg:` class switches it back to
  in-flow `relative` layout. The existing `SidePanel` component is extended to accept an
  overlay-vs-inline mode driven by responsive classes.
- **Backdrop.** Mobile/tablet overlay drawers render a dismissable backdrop
  (`fixed inset-0 bg-black/40`), hidden at `lg:`.
- **No refit wiring changes.** Every transition above changes the terminal container size
  (or overlays it without resizing), both already handled per the section above.

### 2. Bottom bar — content-adaptive, capped

Replace `h-[116px]` with an auto-height, capped flex column. Structure is unchanged
(tab strip → active panel → Commands-only input row):

```
┌─ BottomBar ── flex flex-col, max-h-[40vh] (mobile sheet: up to ~70vh) ─┐
│ [Commands | Env]                              tab strip  (fixed height) │
│ ┌─ panel content ── flex-1 min-h-0 overflow-y-auto ──────────────────┐ │
│ │  quick-cmd buttons (wrap)   /   env file list                       │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌─ input row (Commands tab only) ── fixed height ────────────────────┐ │
│ │  [ multiline textarea ~3 rows ]                             [ → ]    │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

- The bar is `flex flex-col max-h-[40vh]` with **no fixed height**. It grows to fit content.
- The **panel content region** is `flex-1 min-h-0 overflow-y-auto`; when total content
  exceeds the cap, only this region scrolls — the tab strip and input row stay pinned.
- The terminal is a flex sibling (`flex-1 min-h-0`) and absorbs remaining height, so a short
  bottom bar automatically yields a taller terminal. With 5 preset buttons the bar is only
  `tab strip + one button row + input row` tall — noticeably shorter than the old 116px.
- **Cap values:** `40vh` inline (tablet/desktop). The **mobile bottom sheet** may expand
  taller (up to ~`70vh`) because it overlays the terminal and is dismissable.

### 3. Multi-line input

`TerminalToolbar`'s single-line `<Input>` becomes a `<textarea>`-based control.

- **Height:** fixed at ~3 rows (`rows={3}`, `resize-none`). Content beyond 3 rows scrolls
  inside the textarea; no auto-grow.
- **Keys:**
  - `Enter` → submit (send composed text, then clear).
  - `Shift+Enter` → insert a newline.
  - IME guard preserved: skip submit when `e.nativeEvent.isComposing`
    (matches current `TerminalToolbar.tsx:99`).
- **Send button:** retained (`SendHorizontal` icon button); submits identically. Useful on
  touch devices where Enter-to-submit is awkward.
- **Submit semantics (multi-line):** the textarea's literal content — including any embedded
  `\n` newlines — is sent, followed by a single trailing `\r`. A block such as:

  ```
  cd /tmp
  ls
  ```

  is therefore sent as its literal text with a `\n` between the lines and a final `\r`, i.e.
  it runs as **multiple commands** (each newline executes a line). This matches the natural
  expectation of a multi-line box.
- **Disabled state:** unchanged — the control is disabled when the reconnect banner blocks
  input (`toolbarDisabled` / `disabled` prop).

## Components Touched

- `web/src/components/TerminalView.tsx` — responsive container classes; `BottomBar`
  height change (drop `h-[116px]`, add `max-h` cap + flex); wire mobile bottom-sheet
  open/close state; header condensing.
- `web/src/components/SidePanel.tsx` — support overlay (drawer) vs. inline (push) mode
  via responsive classes + backdrop; preserve desktop resize behavior.
- `web/src/components/TerminalToolbar.tsx` — replace `<Input>` with `<textarea>`; Enter/
  Shift+Enter handling; keep Send button and disabled state.
- `web/src/components/FileTabs.tsx` — verify overlay side panel composes with existing
  `onTerminalReveal` refit (likely minimal/no change).

## Testing

- **TerminalToolbar unit tests** (extend `__tests__/TerminalToolbar.test.tsx`):
  Enter submits and clears; Shift+Enter inserts newline (no submit); IME composing suppresses
  submit; multi-line block is sent as literal text + trailing `\r`; disabled state blocks
  input and buttons.
- **Layout/responsive:** component tests asserting the presence of responsive/drawer classes
  at the relevant elements (jsdom can't measure real layout, so assert class contracts and
  drawer open/close state transitions rather than pixel geometry).
- **Bottom bar:** assert no fixed `h-[116px]`; assert `max-h` cap + `overflow-y-auto` on the
  scrolling region.
- **Manual / Playwright:** capture screenshots at all three breakpoints (mobile, tablet,
  desktop) showing terminal + open/closed file drawer + Commands/Env bottom bar, plus a
  multi-line input example. Save to `.playwright-mcp/screenshots/` for the PR body
  (**核心功能截图** section).

## Verification Gates

- `cargo` gates: N/A (web-only change), but run workspace checks if any Rust is touched.
- `cd web && npm run build && npm run lint && npx tsc --noEmit` — all pass, `--max-warnings 0`.
- `npm test` and `npm run coverage` (≥80% threshold) pass.
- No `eslint-disable`; event handlers wrapped (`onClick={() => fn()}`) per project rules.

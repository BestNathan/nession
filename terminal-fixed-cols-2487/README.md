# Fixed-column Terminal / Typography simulator (#2487)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/2487  
**Branch:** shared orphan `prototype` — design artifact only (never merge into main/staging).

## Decision being explored
Find one canonical **column count** for the same Nession Session that remains unchanged as Web and iPhone trade available **width** for actual smaller/greater CSS font sizes. Limit desktop terminal text to a comfortable measured maximum width, center it in larger windows, and change **rows** with usable viewport height. Candidate 88 is a test starting point, **not** the approved production default.

## Walkthrough / critical mock path
1. Open `index.html` in a browser; both Web and iPhone draw identical ASCII-width terminal history, each wrapped at the same column boundary.
2. Choose 80 / 88 / 96 / 100 / 120, drag the column slider, or type an integer between 60 and 140.
3. Compare actual per-device browser font sizes, measured cell width, pixel content width and row counts. All updates are immediate and deterministic.
4. Change Web logical device width or the max Web font, and collapse/expand its sidebar. Beyond the comfortable font cap the terminal is centered with side whitespace; below it the font shrinks while cols stay constant.
5. Switch phone logical widths (393 / 402 / 440 CSS px); toggle the iOS keyboard. Observe a **rows-only** change with unchanged cols and font size for keyboard appearance.
6. Toggle TUI fixture, reset, or copy the current configuration JSON.

## What is real and what is mocked?
- **Real browser DOM** CSS font sizes (fractional px), non-scaled letterforms, 1:1 CSS pixel viewport boxes. No `transform: scale()` or image/screenshots in the terminal. A hidden DOM measurement element measures **80 actual rendered glyphs** at each candidate font size, using binary search to fit `cols × measured cell width` in the content box.
- **Font:** remotely loaded JetBrains Mono Variable woff2 via jsDelivr to approximate Nession's actual `@fontsource-variable/jetbrains-mono`. If unavailable, the browser uses system monospace and **remeasures**, with a visible font status. External font is the only network dependency; the simulator itself is plain HTML/CSS/JS.
- **Mock:** sanitized text fixtures (ASCII for deterministic one-cell columns), terminal chrome, Web sidebar, iPhone shell, keyboard and viewport/rows calculation. CSS line-height follows Nession's current Web/App ratios 1.19/1.31 but **does not claim xterm renderer cell-height equivalence**. Data, Agent Session, tmux pane, streaming, VT parser, ControlLease, gestures and input are not connected.
- **Known limits:** no production API/side effects; no live xterm, no real tmux/PTY size; app browser may enforce font-size accessibility overrides; actual xterm Unicode/wcwidth, mouse-cell mapping, TUI redraw and font rasterization differences require production browser/Agent tests. Mobile at 7px may remain difficult to read; this prototype exposes that visually for the product choice, it does not certify readability.

## Device / interaction checks
- Web presets 1280×800, 1366×768, 1512×982, 1728×1117, 1920×1080; sidebar 248/64px.
- iPhone logical widths 393×852, 402×874, 440×956; keyboard reduces available vertical space by 250px.
- Mouse/pointer/keyboard: slider + number field, selects, checkboxes, preset buttons, reset, copy; horizontal scroll for 1:1 comparison.
- Errors: invalid col is clamped to 60..140, no font load uses fallback, Clipboard denial is reported.

## Verification
- Standalone: `python3 -m http.server 8025` from `prototype` branch root then browse `http://localhost:8025/terminal-fixed-cols-2487/`.
- Static: inspect for well-formed HTML; parse JS and check controls; after publishing fetch immutable commit source.
- Browser: inspect Web/iPhone at 88 and 100 cols, toggle keyboard and sidebar, verify `metric-cols` unchanged while `metric-rows` responds; inspect computed CSS font-size and ensure no transforms on terminal nodes.
- Prototype/design evidence only. None of this marks #2487 production SC or E2E Acceptance Pass.

**Owner:** terminal geometry/design; canonical production implementation remains on main's development workflow, not this orphan branch.

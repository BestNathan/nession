# Mobile Terminal touch-and-hold navigation prototype (#2657)

- **Issue:** https://github.com/BestNathan/nession/issues/2657
- **Purpose:** Test whether single-finger hold then drag is an unobtrusive way to navigate Bash / Vim / TUI with semantic arrow keys on mobile.
- **Entry / critical path:** Terminal Session mock → stationary long press 380ms → radial arrows → drag horizontally/vertically → immediate arrow and 1/2/4/8 keys/s repeat → return to center / release to stop.
- **Root cause of lost mobile movement:** The old mock called `lines.replaceChildren()` on every emitted arrow, **detaching the original TouchEvent target**. Subsequent touchmove/end events then stopped bubbling to the window, so speed, direction and release appeared stuck while the timer kept firing. The fixed mock creates 11 persistent row elements once, updates text in-place, and positions its caret as a stable, pointer-transparent overlay. Never detach an active touch target; production xterm integration must honor the same invariant or use a stable gesture target with coordinated ownership.
- **Architecture:** `gesture-engine.mjs` is the pure `idle → pending → armed ↔ moving → idle` FSM with injectable time/clock, 24/17px center hysteresis, 1/2/4/8 speed bands and one last-key-anchored repeat clock. `prototype-ui.mjs` is the separate TouchEvent/mouse adapter plus DOM renderer and mock PTY consumer. `gesture-engine.test.mjs` runs deterministic state/clock/cancellation tests in Node.
- **Continuous movement:** The repeat timer is anchored to the last emitted key's monotonic timestamp, NOT to the last touch movement. Switching speed from 1→2→4→8 or moving back and forth cannot defer repeat indefinitely; a direction change emits immediately; return to center or release ends the repeater. 80 mock editor rows with an 11-row sliding viewport prevent short-buffer clamping from being mistaken for stopped input.
- **Gesture thresholds:** 24px entry and 17px exit center dead zone, 48/76/108px distance bands, ±5px speed hysteresis and 1.28 axis-switch ratio. Changing speed never emits an extra immediate key. Visible dial is clamped to the terminal, and a small origin dot indicates displaced visual anchors.
- **Negative paths:** quick scroll before activation, 28px left/right edge navigation reservation, touch cancellation, read-only observer, disconnected, document hidden.
- **Device & primary input:** Android / iOS use native `touchstart` → long-press timer → `touchmove` → `touchend` / `touchcancel`. Movement is captured by a **pre-registered, non-passive window-capture move listener** that filters by the initiating `Touch.identifier` (no global blocking while idle); active `touchmove` calls both `preventDefault()` and `stopImmediatePropagation()` after activation. The tracked finger's `touchend` and `touchcancel` are exclusively consumed too, and compatibility clicks are suppressed. Before activation, touch events are untouched, and an early drag is surrendered to native scrolling. During ownership the Terminal scrollbox is temporarily locked at its current offset, then restored on release. Browser long-press callout is suppressed on the prototype Terminal surface; double-tap zoom is not required here. Synthetic mouse-after-touch events are ignored. Desktop fine-pointer mouse hold is a **debug-only** fallback, never the mobile implementation path.
- **Fidelity:** HTML/CSS/JS, entirely local fake TUI and keyboard-event log. No backend, actual PTY, xterm, data persistence or side effects. Visual caret is a mock TUI response, not direct xterm cursor control.
- **Accessibility:** controls are buttons and keyboard reachable; production Terminal Keys remain discoverable as the fallback.
- **Event ownership:** Exclusive ownership starts **on activation**, not on directional selection. The prototype uses early window-capture tracking and a stable, never-detached touch target, then consumes only the armed finger's events (the shell work-surface gate handles its own edge navigation); production should integrate with App gesture/work-surface arbitration rather than rely on listener registration order. Avoid setting `touch-action:none` globally: it would break ordinary scrolling. The CSS scroll lock is a secondary guard and must restore on release.
- **Known uncertainties:** Chromium mobile emulation can exercise native Touch Events, touch-vs-scroll arbitration, continuation and cancellation; it cannot prove WebKit/iOS Safari long-press behavior. iOS real-device validation and TUI mouse/copy behavior remain required for production.
- **Reference:** https://termius.com/blog/new-touch-terminal-on-ios
- **Source of truth:** semantic-key input authority belongs to TerminalInteractionController, shell edges remain App-owned as in docs/design/interaction/app.md.

## Manual checks

1. Tap or scroll quickly within terminal: no emitted arrow.
2. On an actual phone (not mouse emulation), hold stationary: guide appears, Input path says `touch`, and no arrow until exit from center.
3. Drag each direction: event log and mock TUI caret update.
4. While holding over a mock editor line, **repeatedly switch 1→2→4→8→2 speed, turn right→up→down, return to center, and release**. The editor row nodes must never be detached during this touch. Stay held: 4 bounded repeat rates (1/2/4/8 per second); **keep moving across speed thresholds for >2 seconds**, verify key count still rises, then keep finger motionless for >2 seconds and verify repeats; change direction; return center, stop.
5. While armed, confirm "Touch owner: Direction pad", "Exclusive moves" increments, "Leaks to Terminal" remains **0**, and Terminal / page scroll does not move. Release or trigger `touchcancel`, toggle observer/offline: no further emissions. Diagnostic `Last touch event` distinguishes native cancellation from normal release. Quick swipe still scrolls the Terminal.

Mock design exploration only, **not** trusted production Acceptance.

## Verification (prototype revision)

- Pure FSM: `node terminal-direction-2657/gesture-engine.test.mjs` exercises timing, speed changes, four directions, center, cancellation and stale-timer cleanup.
- Chromium mobile TouchEvent/CDP actual browser sequence (390×844 touch viewport): 1→2→4→8→4→2→8 speed changes, right→up→center→down, release→IDLE, quick swipe→native scroll. All passed in a local prototype fixture with the **same engine and adapter source**.
- Known boundary: headless Chromium mobile emulation is not real iOS Safari; the published Pages HTML/manifest and actual Nession xterm/runtime remain independent verification tasks.

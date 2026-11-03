# Mobile Terminal touch-and-hold navigation prototype (#2657)

- **Issue:** https://github.com/BestNathan/nession/issues/2657
- **Purpose:** Test whether single-finger hold then drag is an unobtrusive way to navigate Bash / Vim / TUI with semantic arrow keys on mobile.
- **Entry / critical path:** Terminal Session mock → stationary long press 380ms → radial arrows → drag horizontally/vertically → immediate arrow and 1/2/4/8 keys/s repeat → return to center / release to stop.
- **Gesture thresholds:** 24px entry and 17px exit center dead zone, 48/76/108px distance bands, ±5px speed hysteresis and 1.28 axis-switch ratio. Changing speed never emits an extra immediate key. Visible dial is clamped to the terminal, and a small origin dot indicates displaced visual anchors.
- **Negative paths:** quick scroll before activation, 28px left/right edge navigation reservation, touch cancellation, read-only observer, disconnected, document hidden.
- **Device:** iOS/Android browser touch preferred; desktop mouse hold + drag supported for inspection.
- **Fidelity:** HTML/CSS/JS, entirely local fake TUI and keyboard-event log. No backend, actual PTY, xterm, data persistence or side effects. Visual caret is a mock TUI response, not direct xterm cursor control.
- **Accessibility:** controls are buttons and keyboard reachable; production Terminal Keys remain discoverable as the fallback.
- **Known uncertainties:** iOS/Android context-menu/text-selection and TUI mouse / real scroll gesture arbitration require real-device testing on production code.
- **Reference:** https://termius.com/blog/new-touch-terminal-on-ios
- **Source of truth:** semantic-key input authority belongs to TerminalInteractionController, shell edges remain App-owned as in docs/design/interaction/app.md.

## Manual checks

1. Tap or scroll quickly within terminal: no emitted arrow.
2. Hold stationary: guide appears, no arrow until exit from center.
3. Drag each direction: event log and mock TUI caret update.
4. Stay held: 4 bounded repeat rates (1/2/4/8 per second); change direction; return center, stop.
5. Release, toggle observer/offline: no further emissions.

Mock design exploration only, **not** trusted production Acceptance.

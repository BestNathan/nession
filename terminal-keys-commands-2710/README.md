# Terminal Keys + Quick Commands capsule prototype (#2710)

## Question
Can Nession make real modifier chords and saved command actions reachable on mobile while preserving the already approved Composer/Peek relationship, **and let Terminal output scroll above the highest expanded capsule surface without a PTY resize**?

## Scenario
Open capabilities using the lower + control; select Terminal Keys. A single tap on Ctrl+C emits a simulated atomic chord event. Tap Ctrl then X in the one-shot alphabet selector, Cancel the selected modifier, tap arrows repeatedly, switch to Commands and choose Insert (fills the lower composer) versus Run (adds a simulated execution event). Tap the composer to return to native typing without moving it. When opening +, Keys or Commands, the simulated Terminal automatically reveals its newest prompt just above the top of the highest open panel. Once the panel is open, swipe/drag vertically inside the **visible Terminal area** to scroll earlier and later output. The panel must not trap that gesture, nor may a pending auto-follow callback snap the output back. In history mode, manually scroll older output; changing the panel must preserve that viewing position. Scroll back to live bottom to resume following.

## Fidelity
- **Mock**: terminal output, command inventory, connection status, key serialization/readout and actions. No PTY, shell execution, xterm instance, network or persisted configuration is used.
- **Interaction modeling**: common chord one-tap, one-shot Ctrl/Alt/Shift, A–Z selection, cancel, repeated arrows, command Insert versus Run, panel switching/closing and composer focus. The mock prints expected byte hints for common Ctrl chords; real mode-dependent encoding belongs to TerminalInteractionController and must be proved independently.
- **Layout**: standalone HTML for direct mobile browser, desktop phone preview, 375–430 px widths and short viewport fallback. CSS values approximate canonical Nession light terminal/capsule; no claim they are generated from production tokens.
- **Terminal scroll clearance**: uses `ResizeObserver` on the floating dock and phone root to measure the uppermost panel top and update **scrollable bottom padding**. On opening the + menu / Keys / Commands, if the user is following the live bottom, the mock scrolls to the new live bottom so the last prompt is visible above the uppermost panel, with a small gap. If the user is reading history, the scroll anchor remains unchanged; extra scroll range is available manually. Switching Keys ↔ Commands, closing, window resize and new mock output use the same model. The mock fixture includes 48 output rows so this behavior is testable rather than an illusion from a short terminal buffer.
- **Production constraint (not proven by mock)**: `useCapsuleDockClearance` deliberately reserves geometry only for the composer because its current `--nession-local-terminal-capsule-occlusion` becomes xterm viewport padding and may change rows. The implementation must keep that stable and introduce a **distinct uppermost-panel scroll-clearance owner**, rather than blindly measuring the whole dock as xterm fit occlusion. Test xterm normal scrollback and alternate-screen/mouse-reporting TUI behavior, including moving cursor/live output above the panel, without inadvertent tmux/PTY resize. The HTML CSS scrollroom strategy is an interaction proof, *not* a validated method for xterm's virtual buffer.

- **Scroll gesture correction (2026-11-04):** the Terminal region explicitly uses native `overflow-y: auto` and `touch-action: pan-y`; pointer/touch interaction takes ownership from automatic live-follow and repeated observer notifications with unchanged clearance are ignored. Scrolling up while a panel is open enters history; scrolling back to bottom restores live following. This is **not** a custom swipe-to-scroll engine; it preserves browser-native scroll and avoids duplicating product-level gesture interception.

## Non-goals
Implementing new runtime key APIs, general keyboard protocol negotiation, OSC/clipboard, saved command storage, live Session connection, navigation gestures (#2657), or a production-ready UI.

## Verification
- Source authored as standalone HTML, no third-party runtime dependency.
- **Mock smoke / static**: JavaScript parses; all referenced assets are relative; the gallery and manifest entries resolve.
- **Real browser, published HTTPS preview, 390×844**: the `+` menu opens Keys and Commands; Ctrl+C emitted the mock `0x03` chord; Ctrl → X emitted `0x18`; Cancel cleared the selection; Commands Insert filled the composer and returned focus; Run emitted `[mock] RUN: git status ↵`; following clearance measured 511px with the live line above the panel; a history position (scrollTop 949) survived switching to a panel 105px shorter (clearance 406px) with `scrollMode=history`.
- **Publication fix**: the gallery injects a fixed bottom navigation bar, which at mobile width covered the mock's `+` and composer. The prototype now reserves that height only when the nav is present, so the published page is operable; this was found by the real-browser pass, not by static inspection.
- **Not verified here**: a real PTY, xterm mode-dependent encoding, tmux pane size, mouse-reporting/alternate-screen applications, IME and device safe areas. Those belong to the production implementation and its Acceptance Cases (SC-02/03/04/08/09).
- The prototype remains a mock, not an Acceptance receipt.

## Links
- Owning issue: https://github.com/BestNathan/nession/issues/2710
- Pages preview (verified live): https://bestnathan.github.io/nession/prototypes/terminal-keys-commands-2710/index.html
- Source: https://github.com/BestNathan/nession/tree/prototype/terminal-keys-commands-2710

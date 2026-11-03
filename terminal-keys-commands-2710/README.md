# Terminal Keys + Quick Commands capsule prototype (#2710)

## Question
Can Nession make real modifier chords and saved command actions reachable on mobile while preserving the already approved Composer/Peek relationship and visual grammar?

## Scenario
Open capabilities using the lower + control; select Terminal Keys. A single tap on Ctrl+C emits a simulated atomic chord event. Tap Ctrl then X in the one-shot alphabet selector, Cancel the selected modifier, tap arrows repeatedly, switch to Commands and choose Insert (fills the lower composer) versus Run (adds a simulated execution event). Tap the composer to return to native typing without moving it.

## Fidelity
- **Mock**: terminal output, command inventory, connection status, key serialization/readout and actions. No PTY, shell execution, xterm instance, network or persisted configuration is used.
- **Interaction modeling**: common chord one-tap, one-shot Ctrl/Alt/Shift, A–Z selection, cancel, repeated arrows, command Insert versus Run, panel switching/closing and composer focus. The mock prints expected byte hints for common Ctrl chords; real mode-dependent encoding belongs to TerminalInteractionController and must be proved independently.
- **Layout**: standalone HTML for direct mobile browser, desktop phone preview, 375–430 px widths and short viewport fallback. CSS values approximate canonical Nession light terminal/capsule; no claim they are generated from production tokens.

## Non-goals
Implementing new runtime key APIs, general keyboard protocol negotiation, OSC/clipboard, saved command storage, live Session connection, navigation gestures (#2657), or a production-ready UI.

## Verification
- Source authored as standalone HTML, no third-party runtime dependency.
- Browser interaction, mobile screenshots, IME/safe-area and publication manifest **not yet verified** in this environment; do not treat this prototype as an acceptance receipt.
- Source revision and Pages preview must be pinned/verified before marking the prototype verified.

## Links
- Owning issue: https://github.com/BestNathan/nession/issues/2710
- Expected Pages preview (verify separately): https://bestnathan.github.io/nession/prototypes/terminal-keys-commands-2710/index.html
- Source: https://github.com/BestNathan/nession/tree/prototype/terminal-keys-commands-2710

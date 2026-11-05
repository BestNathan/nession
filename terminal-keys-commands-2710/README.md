# Terminal Keys + Quick Commands capsule prototype (#2710)

## Question
Can Nession make real modifier chords and saved command actions reachable on mobile while preserving the already approved Composer/Peek relationship, **and let Terminal output scroll above the highest expanded capsule surface without a PTY resize**?

## Scenario
Open capabilities using the lower + control; select Terminal Keys. A single tap on Ctrl+C emits a simulated atomic chord event. Tap Ctrl then X in the one-shot alphabet selector, Cancel the selected modifier, tap arrows repeatedly, switch to Commands and choose Insert (fills the lower composer) versus Run (adds a simulated execution event). Tap the composer to return to native typing without moving it. Opening +, Keys or Commands **does not automatically move the Terminal content**. Instead the mock creates enough additional scrollroom: swipe upward on the Terminal to reveal the newest prompt above the expanded panel, and downward again to recover the original first visible line. Once the panel is open, swipe/drag vertically inside the **visible Terminal area** to scroll earlier and later output. The panel must not trap that gesture, nor may a pending auto-follow callback snap the output back. In history mode, manually scroll older output; changing the panel must preserve that viewing position. Scroll back to live bottom to resume following.

## Fidelity
- **Mock**: terminal output, command inventory, connection status, key serialization/readout and actions. No PTY, shell execution, xterm instance, network or persisted configuration is used.
- **Interaction modeling**: common chord one-tap, one-shot Ctrl/Alt/Shift, A–Z selection, cancel, repeated arrows, command Insert versus Run, panel switching/closing and composer focus. The **external mock event log** records expected byte hints for common Ctrl chords; real mode-dependent encoding belongs to TerminalInteractionController and must be proved independently.
- **Layout**: standalone HTML for direct mobile browser, desktop phone preview, 375–430 px widths and short viewport fallback. CSS values approximate canonical Nession light terminal/capsule; no claim they are generated from production tokens.
- **Terminal scroll clearance**: uses `ResizeObserver` on the floating dock and phone root to measure the uppermost panel top and update **scrollable bottom padding**. On opening the + menu / Keys / Commands, the mock **keeps the previous scrollTop anchor** and only expands the available scroll range. The user explicitly scrolls to the new bottom boundary when needed; the top remains reachable by reversing the swipe. If the user is reading history, the scroll anchor remains unchanged; extra scroll range is available manually. Switching Keys ↔ Commands, closing, window resize and new mock output use the same model. The mock fixture includes 48 output rows so this behavior is testable rather than an illusion from a short terminal buffer.
- **Production constraint (not proven by mock)**: `useCapsuleDockClearance` deliberately reserves geometry only for the composer because its current `--nession-local-terminal-capsule-occlusion` becomes xterm viewport padding and may change rows. The implementation must keep that stable and introduce a **distinct uppermost-panel scroll-clearance owner**, rather than blindly measuring the whole dock as xterm fit occlusion. Test xterm normal scrollback and alternate-screen/mouse-reporting TUI behavior, including moving cursor/live output above the panel, without inadvertent tmux/PTY resize. The HTML CSS scrollroom strategy is an interaction proof, *not* a validated method for xterm's virtual buffer.

- **Scroll correction (2026-11-04, revised):** the Terminal uses native `overflow-y: auto` and `touch-action: pan-y` with a **reversible bottom scroll range**. Opening a panel does not push its screen upward. Moving up reveals the latest prompt above the panel; moving down recovers the top. Pointer/touch gestures prevent auto-follow from stealing a manual scroll. No xterm renderer or PTY is used in the mock; the real runtime must implement equivalent reversible pan without mutating rows.

- **Current revision:** JS syntax checked after the non-auto-pushing scroll change. The browser evidence above applies to an earlier revision and is **not** a pass for the updated scroll behavior. Published Pages manifest, actual mobile touch and real xterm/PTY verification are pending.

## New visual-fidelity / presentation-frame trial (2026-11-05; #2758)

- **Skill under test:** [#2759](https://github.com/BestNathan/nession/pull/2759), exact pending Skill commit `4fd741861588550438694f3487b1003b49ed8699`. Applied its `presentation-frame`, `web-app-shell` and `terminal` references to the existing #2710 prototype directory.
- **Product viewport:** a focused Nession **App** Terminal screen, with Session header, Terminal and single upper Peek slot above the bottom Capsule. The Sessions control opens a functional mocked Sessions view; no inert Back or Source action is painted into the app header.
- **External harness:** Issue/source, 375/390/430 viewport selection, reset, test instructions and mock limitations live outside the product UI; at narrow widths, the App viewport fills the initial screen and the harness is below it.
- **Visual sources:** current `web/src/app/patterns/SessionHeader.tsx`, `web/src/app/TerminalWell.tsx`, `web/src/product/terminal/patterns/TerminalSurface.tsx`, `capsuleStyles.ts`, `web/src/app/fixture/FixtureTerminal.tsx` and `docs/design/terminal/terminal-sizing.md`. The standalone mock contains a selected **generated-token snapshot** from `design/generated/web.css` at main commit `c4ea99d10f44b07d6bf043e59a9f557a1e0dd28b`, including App remaps; no runtime imports or network calls.
- **Behavior retained:** atomic chord simulation, modifier selection and cancellation, Commands Insert/Run and native DOM reversible scrollroom behavior. Mock byte hints and execution diagnostics now go to the **external harness event log**, not fabricated `[mock]` lines in Terminal output. The Terminal shows only minimal shell-like response where applicable. Scenario instructions/mock badges are no longer rendered over the Terminal/Peek.
- **Approximations:** plain DOM terminal output and locally approximated CSS/layout, **not** xterm rendering or actual tmux/PTY; viewport/safe-area/IME fidelity requires physical/runtime testing.
- **Verification of this exact revision:** pending published HTTPS/manifest and browser-readback before claiming the interactive preview is current. Old browser receipts and accepted SCs do not prove this visual-only mock revision.

## Standard three-region review frame (2026-11-05; #2758 second iteration)

The owning prototype was migrated in place to the **shared** `../prototype-frame-2758/frame.css` and `frame.js` review frame (source kit [#2758](https://github.com/BestNathan/nession/issues/2758)). It uses **top overview** (problem/Issue/source), a **middle 1:1 CSS-pixel interactive App viewport** (375/390/430 × 844, no zoom/transform), and **bottom functionality/visual baseline/mock boundaries/debug log**. Product-only Session/Terminal/Capsule markup is nested exclusively in the central device viewport.

This explicitly supersedes the previous two-column “phone + side inspector” trial, whose external harness felt unrelated to a unified prototype page. App width selection/reset are handled by the shared `frame.js`; the mock key/command/scroll runtime stays local. The trusted main Pages publisher PR #2759 adds a native top gallery/source-link slot with exact SHA pinning and prevents a fixed footer from covering a structured preview. Legacy published mocks remain compatible.

**Important fidelity distinction:** geometry is 1 CSS pixel to 1 CSS pixel; current Terminal output still uses plain DOM, not the production xterm fixture, so **pixel-perfect product match is NOT claimed**. Visual owner: `web/src/app/patterns/SessionHeader.tsx`, `web/src/product/terminal/{patterns/TerminalSurface.tsx,capsule/TerminalCapsule.tsx}`, `web/src/app/fixture/FixtureTerminal.tsx` and generated `design/generated/web.css` tokens (snapshot main `c4ea99d1`). Review-page CSS is `np-*` only and cannot modify product colors. Source-aligned geometry: QuickChordRow is one horizontal caption + shortcut row, PhysKeyRow is five columns, ModifierRow places three modifiers beside the four-arrow cluster in one row; Key/Arrow App hit targets use the generated 44px band. Known gaps: actual xterm glyph metrics, complete Header/Keycap React appearance, mode-dependent PTY bytes, IME and hardware touch.

**Verification scope:** static structural assertions and source checks passed; a fresh browser read-back, exact published Pages SHA and actual product screenshot comparison remain distinct further gates. Old mock browser receipts predate this new review frame.

## Non-goals
Implementing new runtime key APIs, general keyboard protocol negotiation, OSC/clipboard, saved command storage, live Session connection, navigation gestures (#2657), or a production-ready UI.

## Verification
- Source authored as standalone HTML, no third-party runtime dependency.
- **Mock smoke / static**: JavaScript parses; all referenced assets are relative; the gallery and manifest entries resolve.
- **Historical browser pass on an earlier prototype source** (superseded for scroll behavior): the `+` menu opens Keys and Commands; Ctrl+C emitted the mock `0x03` chord; Ctrl → X emitted `0x18`; Cancel cleared the selection; Commands Insert filled the composer and returned focus; Run emitted `[mock] RUN: git status ↵`; following clearance measured 511px with the live line above the panel; a history position (scrollTop 949) survived switching to a panel 105px shorter (clearance 406px) with `scrollMode=history`.
- **Publication fix**: the gallery injects a fixed bottom navigation bar, which at mobile width covered the mock's `+` and composer. The prototype now reserves that height only when the nav is present, so the published page is operable; this was found by the real-browser pass, not by static inspection.
- **Not verified here**: a real PTY, xterm mode-dependent encoding, tmux pane size, mouse-reporting/alternate-screen applications, IME and device safe areas. Those belong to the production implementation and its Acceptance Cases (SC-02/03/04/08/09).
- The prototype remains a mock, not an Acceptance receipt.

## Links
- Owning issue: https://github.com/BestNathan/nession/issues/2710
- Pages preview (verified live): https://bestnathan.github.io/nession/prototypes/terminal-keys-commands-2710/index.html
- Source: https://github.com/BestNathan/nession/tree/prototype/terminal-keys-commands-2710

### Product-source fidelity review: App header and shortcut glyphs

This revision compared the mock directly with current `web/src/app/patterns/SessionHeader.tsx`, `web/src/app/experiences/app/AppLayout.tsx`, `web/src/app/experiences/app/appTypography.ts` and `web/src/product/terminal/capsule/physKeys.ts`:

- Correct the Session title to use the **App title role** (generated `--nession-typography-title-*`), instead of a hand-written 14px approximation.
- Restore the real App's right-hand **Workspace destination** icon and centered header status spacer; the mock gives the destination a minimal returnable empty layer only, **not** a complete Workspace model.
- Match production QuickChord labels `⌃C` / `⌃R` / `⌃L` and preserve accessible `Ctrl+C` / `Ctrl+R` / `Ctrl+L` names.

This closes those three source-observable differences; it does **not** claim production pixel equivalence, interactive xterm correctness, or that the Workspace mock is complete. Browser/fixture overlay comparison remains necessary.



## Source parity: fixed-column Terminal rendering (2026-11-05, #2758)

A concrete mismatch in the previous mock: the Terminal had hardcoded `12.5px / 1.55` typography at phone widths, which is **not** the Nession App geometry. Production fits **96 canonical columns** (release default) to the available content width, with no App font-size minimum, using measured xterm cell widths and a 14 CSS-px release ceiling; App Terminal seeds at 11.5px/1.14 and has 14px x/y insets. Sources:
`docs/design/terminal/terminal-sizing.md`,
`web/src/platform/terminal-runtime/sizing.ts`,
`web/src/app/fixture/FixtureTerminal.tsx`,
`design/generated/terminal.ts`.

This mock now:
- Measures a browser DOM glyph ruler in the actual monospace fallback stack, bisects a font size at 0.05px resolution for **96 columns**, and centers the bounded content width within the 14px insets; it recalculates after 375/390/430 width changes and settled font loads.
- Takes the exact generated Terminal theme's `#fff` background, `#24292f` foreground, `#0969da` cursor, rather than using a generic ring-colored cursor.
- Keeps enough deterministic mock scrollback rows (160) to exercise reversible scroll clearance at the substantially smaller App font. Aligns directional-key presentation order with the production `physKeys.ts` inventory.
- Removes an obsolete runtime `manifest.json` fetch that mutated the trusted publisher's **exact pinned HTML Source** href into a branch-like directory link. The trusted Pages publisher is now the sole source-link pinning owner.

**Fidelity boundary:** DOM ruler measurement is an approximation, **not** xterm's measured-cell lifecycle, terminal rows, PTY buffer, ANSI parser, touch/IME, or pixel-perfect parity. This mock also uses the release default 96 columns, rather than an attached Session's authoritative `terminal_cols`. Real fixture screenshot comparison and browser tests remain required.

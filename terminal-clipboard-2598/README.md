# Terminal Clipboard Protocols · #2598

**Owning Requirement:** https://github.com/BestNathan/nession/issues/2598  
**Branch:** shared orphan `prototype` — design artifact only (never merge into main/staging).

## Decision being explored

How the terminal surface states the **transient** clipboard states introduced by OSC 52 / OSC 5522 without adding a permanent toolbar, stealing terminal focus, or claiming a copy/paste that did not happen:

- a browser-blocked OSC 52 copy offers one explicit **Copy** gesture;
- a refused OSC 5522 clipboard write says it was blocked;
- an image-only paste into a TUI that has **not** enabled OSC 5522 says `Image clipboard protocol not supported by this TUI` and sends nothing;
- a negotiated 5522 image paste succeeds silently (no persistent UI).

## Walkthrough / critical mock path

1. Open `index.html` in a browser (or via the Pages preview).
2. **TUI: copy text** with *Browser blocks async clipboard writes* off → the mock clipboard chip updates and nothing else appears (success is silent).
3. Enable **Browser blocks async clipboard writes**, trigger **TUI: copy text** → a transient strip appears below the terminal well with a **Copy** button. Clicking it completes the copy and the strip disappears; it also expires on its own.
4. Trigger **TUI: write an image** with blocking on → a transient refused-write strip.
5. With *TUI enabled OSC 5522* **off**, trigger **User: paste an image** → one sentence, no send, no file, no path; the transcript records that nothing was sent. With it **on**, the same action is silent and the transcript shows the TUI receiving `image/png · 5,000 bytes · DONE`.
6. **User: paste text** shows the ordinary bracketed-paste path, untouched by the protocol states.
7. Toggle **This client is a passive observer** → every copy/paste action is ignored with a transcript note and no clipboard effect; a "View only" bar is shown.
8. Narrow the window below 760px: the controls stack under the terminal; the strip stays beside the well, never over the grid.

Keyboard/focus: all controls are native buttons/checkboxes with visible focus. Clicking a control does not move focus into the terminal, and nothing in the strip auto-focuses; the terminal keeps its own click-to-focus caret.

## What is real and what is mocked?

- **Real browser:** DOM geometry, layout at Web and narrow widths, focus order, keyboard operation of controls, transient timers, `role="status"` announcement.
- **Mock:** every clipboard value, the terminal transcript, the TUI behavior, and the browser permission result. There is no real `navigator.clipboard` call, no Session/PTY/network, no real MIME bytes, no real OSC parser.
- **Not shown here:** real browser permission prompts (Chrome/Safari/Firefox differ), real OSC 52/5522 bytes on the wire, tmux control-mode behavior, multi-client lease authority, or binary image transfer. Those are proven by the Requirement's source-aligned Cases, not by this mock.

## Fidelity classification

| Aspect | Fidelity |
|---|---|
| Layout, transient strip placement, notice copy | design mock |
| Clipboard values and TUI transcript | mock |
| Browser permission refusal | mock (a checkbox, not the Permission API) |
| Focus/keyboard behavior of the mock controls | real DOM behavior of this mock, not the production component |
| Production `TerminalClipboardProtocol`, xterm parser, OS clipboard | not present here |

## Verification

- Static: HTML/CSS/JS are one self-contained file with no external assets; every interactive control is wired; no secrets, addresses or recorded user data. The gallery card and source link resolve; the target page returns 200.
- Browser (executed 2026-10-29, Chromium via Playwright, local static server):
  - 1280×800: silent copy updated the mock clipboard with no strip; blocked copy showed `copy-required` with a visible Copy button, the gesture completed the copy, and the screen kept focus; refused image write showed `write-denied`; unnegotiated image paste showed `unsupported-image-paste` with the exact sentence and no clipboard change; negotiated image paste was silent and logged the TUI receipt; observer mode ignored every action and showed the view-only bar; reset restored the initial state.
  - 390×844: no horizontal scroll (`scrollWidth <= innerWidth`), controls stack below the terminal card, and the strip sits inside the card below the screen rather than over it.
  - No page errors or failed resource loads.
- Prototype/design evidence only. It does not mark any #2598 Acceptance criterion Pass; trusted Cases on the exact staging SHA own that.

## Non-goals

No real clipboard integration, no Files/upload path, no app-specific adapter, no production component extraction. Production ownership stays with `web/src/platform/terminal-runtime/clipboard/` and `TerminalSurface`.

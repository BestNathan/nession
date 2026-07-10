# Decouple Web Terminal Resize from tmux Window Size

**Date:** 2026-07-09
**Status:** approved

## Goal

Stop synchronizing xterm.js resize events to the remote tmux session. The web
terminal canvas should follow the browser window independently, relying on
terminal auto-wrap for text reflow instead of resizing tmux's internal window.

## Background

Currently, when the user resizes the browser window (or the terminal container
changes size), the web client sends the new dimensions (`cols` × `rows`) to the
agent, which calls `PtySession::resize()` → `ioctl(TIOCSWINSZ)` to resize the
underlying PTY. Tmux picks up the SIGWINCH and redraws its screen at the new
dimensions.

This couples the web UI layout to tmux's internal terminal grid. The coupling
has two costs:

1. Every resize triggers a full tmux screen redraw, wasting bandwidth and CPU.
2. In P2P mode, resize messages add latency to a path that should be fast.

Empirical testing (see `docs/superpowers/specs/2026-07-09-decouple-terminal-resize-design.md`
commit history for raw PTY captures) confirmed that tmux's PTY output does
**not** insert explicit `\r`/`\n` at wrap boundaries — wrapping is handled by
the terminal emulator's auto-wrap mode. This means xterm.js at column count
_wide_ will naturally reflow text output from a tmux session at column count
_narrow_ without hard-break artifacts.

## Design

### What changes

**Single file:** `web/src/components/Terminal.tsx`

| Keep | Remove |
|------|--------|
| `fitAddon.fit()` — canvas fills container | `sendResize()` function |
| Initial width/height in `client.attach` payload | `sendResize()` call in `doAttach` |
| `refit()` imperative handle (fit only) | `sendResize()` call in `refit()` |
| Window resize listener → `fitAddon.fit()` | `sendResize()` call in window resize handler |
| Debounce timer (no longer needed — `fit()` is lightweight) | P2P `terminal.resize` message send |
| | Relay `serverConnection.sendTerminalResize()` call |

### What stays the same

- `PtySession::resize()` / `resize()` method on the agent — kept for future use
  (CLI clients may still want resize), just no longer called from the web client.
- `terminal.resize` protocol message type — kept in protocol definitions,
  no schema changes needed.
- Server relay of `terminal.resize` — kept for CLI client compatibility.

### Behavior

| Before | After |
|--------|-------|
| xterm resize → push cols/rows to tmux → tmux redraws at new size | xterm resize → only `fitAddon.fit()` |
| tmux and web terminal width always equal | tmux stays at initial width (default 80×24) |
| Coupled: every layout shift triggers network round-trip | Decoupled: layout is purely client-side |

## Rationale

- **Minimal blast radius** — one file, no protocol changes, no server/agent
  rebuild required.
- **Graceful fallback** — tmux starts at a reasonable default (80×24); CLI
  clients are unaffected.
- **Empirically validated** — raw PTY captures prove auto-wrap handles reflow
  without artifacts.

## Non-goals

- Removing resize capability from the agent/server protocol.
- Changing the initial tmux session dimensions.
- Handling programs that query `$COLUMNS` and hard-format output (edge case,
  acceptable trade-off).

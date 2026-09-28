# Terminal interaction semantics (#1096)

> Requirement: [GitHub #1096](https://github.com/BestNathan/nession/issues/1096).  
> Upstream: [terminal-surface.md](../design-system/patterns/terminal-surface.md).

One **TerminalInteractionController** owns PTY-bound bytes: keyboard (via xterm `onData`), semantic special keys (via xterm helper keyboard events), paste (`terminal.paste`), and committed IME text (`terminal.input`). UI adapters must not embed VT escape tables.

**Control bytes are data.** Every byte a terminal interaction produces reaches the PTY unchanged — `Ctrl+D` (`0x04`) included, which Nession used to read as its own disconnect. Disconnect is an explicit product action and never inferred from a byte.

**Bracketed paste is xterm's mode, not an adapter's.** Paste enters through `terminal.paste`, so the wrapping follows whatever `?2004` state the terminal is in. An adapter that wraps a paste itself would be a second, disagreeing encoder. Desktop clipboard reaches it through xterm's own textarea; mobile through `MobileImeInput`; there is no capsule paste path by design (`terminal-capsule.md` §Anti-patterns).

**The application's terminal state reaches xterm unmediated — and that is a property of the attach transport, not of this layer.** Almost everything below is a measurement of what happens when it does not, and the whole section exists so the next reader does not re-derive it.

Under `AttachMode::control` (the default, #321 S3) the agent pipes the pane's own output, so `mouseTrackingMode`, `buffer.active.type` and bracketed-paste state are **the application's**. A shell never enters the alternate screen and keeps its scrollback; a TUI enters it because it asked; `shouldScrollLocally()` (`occlusionScroll.ts`) reads a mode that distinguishes, which is what it was written for.

Under `AttachMode::plain` — still selectable, and the only mode this section's measurements are true of — tmux's *client* owns the outer terminal and does two things unconditionally on 3.6b: it enters the alternate screen (`?1049h`; `smcup@` overrides and `alternate-screen off` were measured not to prevent it) and it enables mouse reporting, because nession sets `mouse on` at Session creation. So xterm is never on its normal buffer and `mouseTrackingMode` is never `none`, and `shouldScrollLocally()` is dead code there. **The scrollback and mouse criteria are unreachable under `plain`**, which is why they are stated as Control-only rather than as an open question. `#{mouse_any_flag}` exposes the application's own request to the agent and would be the route to a truthful signal if that path ever needed one.

**The deterministic fixture** (`e2e/fixtures/pty-probe.sh`) is the correctness gate: it enters a terminal mode with real DECSET and echoes the exact bytes it receives, so a browser test reads `ESC O A` as `^[OA` and `ESC [ A` as `^[[A`. Real applications are smoke tests, not the specification. Four of its six modes — `altscreen`, `bracketed-paste`, `mouse-vt200`, `mouse-sgr` — **cannot discriminate under `plain`** for the reason above; their truth lives on the tmux side there, so a browser assertion over them would pass for the wrong reason. Under `control` they do discriminate, which is what the browser coverage for them exercises.

**Out of scope here:** multi-client resize authority (#1095), durable replay (#1094), and the attach bootstrap and local scrollback sourcing ([#321](https://github.com/BestNathan/nession/issues/321)).

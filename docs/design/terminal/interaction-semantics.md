# Terminal interaction semantics (#1096)

> Requirement: [GitHub #1096](https://github.com/BestNathan/nession/issues/1096).  
> Upstream: [terminal-surface.md](../design-system/patterns/terminal-surface.md).

One **TerminalInteractionController** owns PTY-bound bytes: keyboard (via xterm `onData`), semantic special keys (via xterm helper keyboard events), paste (`terminal.paste`), and committed IME text (`terminal.input`). UI adapters must not embed VT escape tables.

**Control bytes are data.** Every byte a terminal interaction produces reaches the PTY unchanged — `Ctrl+D` (`0x04`) included, which Nession used to read as its own disconnect. Disconnect is an explicit product action and never inferred from a byte.

**Bracketed paste is xterm's mode, not an adapter's.** Paste enters through `terminal.paste`, so the wrapping follows whatever `?2004` state the terminal is in — including, as measured, tmux's (its client enables bracketed paste on its own outer terminal unconditionally). An adapter that wraps a paste itself would be a second, disagreeing encoder. Desktop clipboard reaches it through xterm's own textarea; mobile through `MobileImeInput`; there is no capsule paste path by design (`terminal-capsule.md` §Anti-patterns).

**Mouse and wheel ownership is open**, and the measurements that decide it are not the obvious ones. `mouseTrackingMode` reports the *client's* terminal: with tmux's `mouse on` — which nession sets when it creates a Session — tmux enables mouse reporting on its client whether or not the application asked, so the mode stops distinguishing anything. `mouse off` lets tmux forward the application's own request, which is truthful; `#{mouse_any_flag}` exposes the same fact to the agent. Independently, tmux's client always enters the alternate screen (`?1049h`, unconditional — `smcup@` overrides and `alternate-screen off` were measured not to prevent it), and the alternate screen has no scrollback, so "scroll local history" has no history to scroll until #321 supplies one. The three move together; see #1096.

**The deterministic fixture** (`e2e/fixtures/pty-probe.sh`) is the correctness gate: it enters a terminal mode with real DECSET and echoes the exact bytes it receives, so a browser test reads `ESC O A` as `^[OA` and `ESC [ A` as `^[[A`. Real applications are smoke tests, not the specification. Four of its six modes — `altscreen`, `bracketed-paste`, `mouse-vt200`, `mouse-sgr` — **cannot discriminate from the browser** for the reason above; their truth lives on the tmux side, so a browser assertion over them would pass for the wrong reason.

**Out of scope here:** multi-client resize authority (#1095), durable replay (#1094), local scrollback sourcing (#321).

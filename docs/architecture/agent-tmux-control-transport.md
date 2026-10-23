# Agent tmux Control Mode transport

Owner: [`crates/nession-agent/src/tmux/client/`](../../crates/nession-agent/src/tmux/client/)
— the typed, session-owned Control Mode client and its transports.
`ControlModeSession` is the session-level adapter above it (bootstrap capture
barrier, window-size guard). [`TmuxOps`](../../crates/nession-agent/src/tmux/ops.rs)
stays the operation-semantics owner, and [`TmuxCmd`](../../crates/nession-agent/src/tmux/cmd.rs)
owns process addressing (`-S <private socket>`, inherited-env scrubbing). Plain
`PtySession` remains a separate backend for plain (non-Control-Mode) attach.

## Two carriers, one protocol

| | `-C + Pipe` (default) | `-CC + PTY` |
|---|---|---|
| process | `tmux -C attach` | `tmux -CC attach` |
| protocol fd | separate stdin/stdout pipes | the client's stdin tty (master/slave PTY) |
| terminal framing | none | DCS `ESC P 1000 p` … ST `ESC \` |
| line endings | tmux records | tmux writes `CRLF` |
| terminal state | none | raw termios required before the child starts |

The Control Mode grammar, the ordered command/reply matcher, the single
ordered event stream and the capture barrier are identical on both. A
transport supplies a byte-stream pair and — for `-CC` — removes terminal
framing before the client's framing sees a byte. Choosing the PTY transport
cannot change the protocol, only the carrier.

## `-CC` specifics

- The introducer is stripped at the start of the stream; the closing ST is
  stripped at its end. tmux 3.6b writes `%exit` and then ST (measured on a
  private socket).
- **Only the closing ST is framing.** A `capture-pane -e` body is raw terminal
  content: a pane line holding an OSC-8 hyperlink ends its sequence with a real
  `ESC \`. Stripping every pair would silently corrupt the snapshot, so an
  `ESC \` is held until the next byte proves it data, and a pair with nothing
  after it is the closing framing.
- The slave is put in raw mode *before* the child starts. With `ECHO` still on,
  every command the client writes would be echoed back on the same master and
  read as protocol noise.
- The parent drops the slave after spawn; the master is `dup`'d twice, made
  `O_NONBLOCK`, and driven through `tokio::io::unix::AsyncFd`. The client's
  reader then applies the terminal framing filter.
- The PTY is created at the size the session just set on the window. tmux uses
  its client's tty size under `window-size latest`, so passing the current size
  keeps the attach from moving the shared window as a side effect.

## Selection and failure

- Production default is `-C + Pipe` (`TmuxClient::connect`).
- `NESSION_TMUX_CONTROL_TRANSPORT=pty` selects `-CC + PTY` for new Agent
  attachments. It is a controlled opt-in for parity evaluation, not a user
  setting; any other value (including unset) keeps the default.
- A failed launch is an error and never falls back to the other transport. A
  child that dies before the welcome pair is reported as `SourceLost` on the
  event stream, on both transports.
- Detach never SIGKILLs a control client: the detach is written through the
  ordered writer and the process is reaped with a bound (Homebrew tmux 3.6b can
  crash its server when a control client is killed).

## Tradeoffs

- **Pipe** needs no PTY, has no terminal framing to normalise, and is the
  lowest-surface carrier for a protocol-only client. It is the default.
- **PTY** is required for any `-CC` client and is the only way to attach a
  Control Mode client that also owns a tty. It inherits tty semantics (termios,
  hangup, flow control) and adds framing normalisation. It is not claimed to be
  faster; parity is the reason to run it.
- The per-client viewport mechanism (`refresh-client -C`) is deliberately not
  used: every attached client is fed the same `%output` stream, so per-client
  viewports could not be rendered coherently (shared window, last writer wins).

## Invariants to preserve

- One session-owned attachment; a P2P/Relay subscriber coming or going never
  creates or destroys it.
- Input is loss-intolerant: one ordered writer, byte-exact `send-keys -H`,
  bounded pending commands, tombstones for timed-out replies.
- The bootstrap capture and the live stream join exactly: output the snapshot
  covers is dropped, interleaved output is live, neither is duplicated.
- A framing/source failure fails closed; it never claims continuity or a
  verified checkpoint afterwards.

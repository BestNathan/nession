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

## Command response body framing (measured 2026-10-24 and 2026-10-25, tmux 3.6b)

`capture-pane` output arrives between `%begin <ts> <id> <flags>` and the
matching `%end`/`%error`. Measured on tmux 3.6b over **both** transports (`-C`
pipe and `-CC` PTY):

- output lines are **not escaped**: a pane line may be exactly `%exit`,
  `%output %0 …`, `%layout-change …`, `%window-resize …` or `%begin <ts> <id>
  <flags>`, may be empty, and may look like a malformed or differently-triple'd
  control record;
- notifications do not interleave **inside** a response block. A blocking
  `wait-for` held a block open while another client resized the window: the
  resulting `%layout-change` arrived **after** `%end` on both transports, never
  between `%begin` and `%end`. Continuous pane output and cross-client resize
  measurements agree.

**Contract:** inside an open block, only the matching `%end`/`%error` is
protocol; *every* other line is response body, including a line that parses as
a well-formed notification. Routing a notification-shaped body line as that
notification would lose captured bytes, fabricate live output or a resize, or —
for a pane line that reads `%exit` — close the attachment (#2378 SC-02). The
old "handle well-formed notifications inside a block" arm was a fidelity bug
built on a synthetic wire shape tmux does not produce; the earlier synthetic
resize-inside-block regression is replaced by the measured contract and a real
`-C`/`-CC` witness.

Two consequences are deliberate:

- a body line exactly `%error <the open block's own triple>` still terminates
  the block as an error; colliding with the live triple is not a reachable pane
  line, so this is the only ambiguity left;
- if tmux really does emit `%exit` while a block is open (server shutdown), the
  line is body and the attachment ends at the following EOF as a stated source
  loss instead of a graceful exit. Source loss is truthful and bounded; losing
  a captured `%exit` line is not acceptable.

Empty lines are real lines: the body joins them with `\n` and tracks "a line
was seen" separately from byte length.

## Adapter handoff bounds (#2387/#2388)

The typed client's ordered stream ends in `ControlModeSession`, which hands two
things to the Agent. Both handoffs are bounded so a stalled consumer cannot
freeze the single ordered forwarder or hold unaccounted memory:

- **Output** — the handoff carries an aggregate byte budget (32 MiB default)
  and a 10 s deadline covering both credit acquisition and the queue send.
  Taking a chunk releases exactly the credit it holds; a failed, timed-out or
  cancelled send refunds it. On overload the forwarder ends, closing the stream;
  the Agent retires the epoch and reports `terminal-stream-lost` — never a
  healthy-looking freeze. The client's own 32 MiB ingress budget is not a
  whole-pipeline bound because it releases on receive; this second budget owns
  the adapter-to-Agent queue.
- **Resize** — a **level, not a record stream**. The forwarder publishes the
  latest authoritative size through a `watch` channel that never waits; a
  stalled consumer reads the final size when it resumes. Intermediate sizes are
  superseded by the final one by definition, so coalescing invents no stream
  cursor and cannot leave the pane at a size no client is looking at. The
  Agent's resize reporter and peer fanout are already last-writer-wins levels,
  so no ordering contract is weakened. A count-bounded queue with a blocking
  send is not acceptable here: it could suspend output and source-loss handling
  behind a resize consumer that is alive but not reading.

## Invariants to preserve

- One session-owned attachment; a P2P/Relay subscriber coming or going never
  creates or destroys it.
- Input is loss-intolerant: one ordered writer, byte-exact `send-keys -H`,
  bounded pending commands, tombstones for timed-out replies.
- The bootstrap capture and the live stream join exactly: output the snapshot
  covers is dropped, output after the block is live, neither is duplicated; an
  in-block output-shaped line is body (#2378).
- The adapter-to-Agent output handoff is byte-bounded by its own credit, and a
  stalled consumer ends the stream in bounded time with a stated loss (#2387).
- Resize is delivered as the latest authoritative level and never blocks the
  single ordered forwarder (#2388).
- Response-body framing is line-aware: empty lines are preserved and, inside a
  block, only the matching terminator is protocol — every other line, including
  a well-formed notification-shaped one, is content, never a protocol fault
  and never a live source event (#2378).
- A framing/source failure fails closed; it never claims continuity or a
  verified checkpoint afterwards.

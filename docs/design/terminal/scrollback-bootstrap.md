# Scrollback & attach bootstrap (#321)

> Requirement: [GitHub #321](https://github.com/BestNathan/nession/issues/321).
> Interacts with [#1096](https://github.com/BestNathan/nession/issues/1096)
> (PTY-faithful interaction, whose criterion 13 is the mode half below).

A Session's visible context is there the moment a client attaches, on every
path; ordinary history browsing is native xterm scrolling and never tmux copy
mode; and the terminal's own state reaches xterm unmediated.

This document is the canonical owner of the transfer that makes the first of
those true — what a **bootstrap** is, what it carries, and what it cannot.

## What a bootstrap is

A **bootstrap** is the session's history, sent to a client that has just
attached, as a snapshot to be *replaced* rather than appended to. That
distinction is the whole contract and it is why the agent can re-send history on
every attach that needs one without the user ending up with two copies of it.

It is not part of the terminal stream. It carries no `stream_epoch`/`stream_seq`
and it is not recorded in the stream log: it is a snapshot taken *before* the
stream it precedes, not an event in it. Recording one would put it inside
`agent.terminal.stream.resume`'s replay window, which is duplication by
construction — the class [#1148](https://github.com/BestNathan/nession/issues/1148)
measured.

It is also not the transport's redraw, and it cannot be: see
[What a capture cannot carry](#what-a-capture-cannot-carry).

## Where the history comes from

**Depth is the agent's decision, not the image's.** `HISTORY_LIMIT_LINES`
(5000) is set by the agent as a tmux **server default** before any window
exists, carried as `tmux -f <socket-dir>/nession.conf`. Two facts force that
shape:

- `set-option -t <session> history-limit N` is not retroactive. From the tmux
  manual: *"This setting applies only to new windows - existing window
  histories are not resized and retain the limit at the point they were
  created."* It has to be set before the window exists.
- `-f` is read only when tmux **starts a server**, which is the only moment
  before the first window. `set-option -g` on a cold socket cannot work, because
  `exit-empty` is on and a `start-server` that creates nothing exits
  immediately.

It used to be nobody's decision: the agent set nothing, tmux defaulted to 2000,
and the image's `~/.tmux.conf` said 50000 — so a bare-metal agent and a container
agent retained different amounts, and `deploy/entrypoint-agent.sh` only writes
that file when it is *missing*, which means a PVC-backed `/root` keeps whatever
an older image wrote.

**Text is `capture-pane`, bounded by bytes.** The snapshot is
`capture-pane -t <s> -p -S -<lines> -E - -e -J`, capped at `BOOTSTRAP_MAX_BYTES`
(512 KiB) from the tail and starting on a line boundary. A byte ceiling and not
a line count, because `-e` re-emits attributes on every line and ANSI-dense
output is an order of magnitude heavier per line than a prompt — the ceiling is
what makes the bound real, and 512 KiB is chosen so an ordinary 5000-line
capture is not truncated at all while still fitting one frame well inside the
outbound budget.

**`-J` is what makes the snapshot *logical* lines.** A capture is emitted one
line per **grid row**, and tmux wraps long lines in its own grid — so without
`-J` a line the pane wrapped at 80 arrives as two, and nothing downstream can
rejoin them: to a terminal, that break is indistinguishable from a real
newline. xterm *does* re-join a row it wrapped itself when the grid changes
(measured: a 107-character line written into an 80-column xterm comes back as
one row after a resize to 142, deep into the scrollback), which is exactly the
distinction. It matters because the pane is created at the default 80×24 when
the client has not measured yet — the ordinary case on a reload — so an
unjoined capture is what made every restored history 80-column fragments inside
a 142-column terminal.

**The pane's unwritten screen is dropped, not sent.** `-S - -E -` captures from
the start of the history to the bottom of the **visible pane**, and a pane that
has run three commands is mostly rows nothing was ever written to. Measured on a
41-row screen: 40 captured lines, **13 of them empty**, with the pane's own
cursor reported at `cursor_y 27` — the row the last prompt sits on. Every empty
row was written into xterm anyway and the cursor landed on the last of them, so
the session's content arrived at the top of a mostly-empty screen with the caret
far below it: 41 rows of screen geometry presented as 41 rows of history.

`bootstrap::strip_trailing_blank_rows` removes the trailing run before the
ceiling is applied, so the bound counts history. A row counts as blank when
nothing on it would be visible — no bytes, or only whitespace and escape
sequences. tmux emits a bare empty line today, and defining it as "zero bytes"
would be a definition that silently stops being the right one the first time a
version pads instead of trimming. The last line's terminator goes with it: a
terminal's cursor sits where the application left it — after `root:~# `, not on
the row below — and a stream ending in a bare LF puts it one row lower than the
pane it is mirroring.

**Modalities are tmux's format variables.** See below.

## The barrier

The snapshot is enqueued, **awaited**, before the live forwarder is spawned:

```text
resize the pane to the client's grid
capture the pane
create the live backend
enqueue the bootstrap            ← awaited, in order
spawn live forwarding
answer the attach
```

That ordering *is* the barrier. The live producer does not exist yet and the
outbound queue is FIFO, so nothing the session produces can overtake the
snapshot — there is no gap to close and nothing to reconcile afterwards. The
alternative, a cursor plus a reconciliation pass, is the shape #1148 measured
going wrong. An `Err` on the enqueue is logged and the attach proceeds: a client
with no history is a client with an empty screen, which is the state every
attach was in before this existed.

**A stalled bootstrap ends the connection with no reply.** The arithmetic makes
that a bad-link case rather than a slow-client case (683 KiB across the 15 s
stall grace implies ~45 KiB/s, above the ~23 KiB/s floor that policy calls "not
slow, gone"), but the verdict is deliberately the same one the live-output task
takes.

## The client's half

**`needs_bootstrap` is the client's answer to a question the agent cannot
answer.** The agent knows whether the *backend* is attached; it does not know
whether the client's xterm still holds that history. Those come apart exactly
where it matters: a page that reattached over a surviving socket has its buffer
and would show a duplicate, while one whose xterm was rebuilt has nothing.
`None` means "decide it yourself", which preserves an older client's behaviour:
`already_attached` then sends nothing, and a first attach sends the history.

The client decides from `hasSessionOutput`, which latches on the first frame of
session output and is read at attach time through the Terminal rather than
cached in the runtime — the runtime is rebuilt under a surviving xterm, and a
stale "empty" is the direction that duplicates on screen.

**A marked frame replaces the buffer; an unmarked one appends.** On the marker
the client writes `\x1b[2J\x1b[3J\x1b[H` — erase display, erase scrollback,
cursor home — and **not** `terminal.reset()`, which also leaves every mode the
application set, including a TUI's alternate screen. With no marker there is no
wipe, so a `stream.resume` replay and a DOM reparent keep what they had.

**A snapshot the ceiling cut short replaces the screen, not the scrollback.**
The marker carries the agent's own account of the capture —
`TerminalBootstrapPayload { requested_lines, truncated }` — and `truncated` is
the one case where "replaces the buffer" would destroy more than it restores.
The ceiling drops from the **tail's** far end: a cut snapshot is newer but
*shorter* than what a long-attached client holds, and the client's scrollback
budget is deliberately larger than any capture the agent can send (10k lines
mobile / 50k desktop against a 5000-line, 512 KiB ceiling). So a truncated
snapshot gets `\x1b[2J\x1b[H` — erase display, cursor home — and keeps the
scrollback: the screen it can authoritatively restore is replaced, and the
history it cannot refill is not thrown away for it (#1305). This is the
narrower rule; the general one above still holds for a complete snapshot, and
for a client that has nothing to lose the two differ only in a scrollback they
do not have.

## What a capture cannot carry

**Private modes.** Terminal modes are state, not text attributes, and
`capture-pane` reconstructs a capture from the grid: measured against a pane put
into `?1h`, `capture-pane -e` emits SGR attribute escapes and nothing else. So a
client that rebuilt its terminal came back in default cursor mode while the
application waited for `^[OA`, and its next arrow key went out as `^[[A`
(#1096 criterion 13).

The fix asks **tmux**, which owns the pane's terminal and already keeps these
flags to redraw with. `TmuxOps::pane_mode_flags` reads them as format variables
(`#{keypad_cursor_flag}`, `#{alternate_on}`, `#{mouse_*_flag}`, …) and
`bootstrap::mode_escapes` translates them into the escapes, which are prepended
to the snapshot: the application's screen is entered before its text is written
into it. `?1049` is emitted only when it is set — entering a screen is what the
snapshot requires, and leaving one is not a state a fresh client can be asserted
out of.

Tracking the modes from the output stream instead was rejected: it re-derives
state tmux already holds, and fails exactly where the stream is lossy — a
resumed control connection, a chunk boundary inside a sequence, or output
produced before the agent attached.

**Bracketed paste (`?2004`) is not restored.** tmux exposes no format variable
for it (3.6b's FORMATS list has the flags above and no others). An application
that enabled it before the client attached does not get it back until it
re-asserts it.

## An attach announces no size

A fresh attach tells the client nothing about the pane's size, and that is a
fix rather than an omission ([#1187](https://github.com/BestNathan/nession/issues/1187)).
The arm used to query the pane and send `terminal.resize`, so the attaching
client would know what xterm should expect. It cannot be told that — the client
is still measuring at attach time. Measured from a CI run's WebSocket capture:

```text
2072.0  client → server   relay.begin {cols:124, rows:26}
2090.1  client → agent    resize      {cols:124, rows:26}
2146.8  agent  → client   resize      {cols:80,  rows:24}   ← stale, and it landed last
```

The backend was created at 80×24 — the Server's default for a client that had
not measured yet — so that is what the query answered, and it arrived after the
client's own fit. The client applied it, leaving a grid of 80×24 over a pane of
124×26 for the rest of the session. The attaching client is the one actor that
cannot need the announcement: it is the authority on its own viewport, and every
size it will ever want it states itself. A peer reflowing the pane is a
different actor and still arrives through the resize fan-out.

## Transports: what each one can promise

| | `AttachMode::Control` (default) | `AttachMode::Plain` |
|---|---|---|
| xterm sees | the application's own stream | tmux's client rendering |
| Buffer type for a shell | `normal` | `alternate`, always |
| Mouse reporting | the application's, unmodified | forced on by Nession's `mouse on` |
| Bootstrap | yes | yes |
| Modes restored | yes | yes |
| Local scrollback browsing | yes | no — the wheel goes to tmux copy mode |

The last three rows are the split. `CapsuleOcclusionScroll.shouldScrollLocally()`
is the right policy — scroll locally iff the application is not asking for the
mouse *and* there is normal-buffer history — and under Plain both halves are
permanently false, so it is dead code there. #1096 criteria 7–10 and #321
SC10–12 are **Control-only**; Plain satisfies the bootstrap invariant and
nothing above it. Plain is kept as a fallback, not as an equivalent.

## What is impossible

- **"No observable gap" is bounded by the capture.** The achievable claim is *no
  gap between the snapshot and the live stream*, which is what the ordering and
  the contiguity test prove. Absolute gap-freedom is not provable by any test
  here, and a session created before the history depth became the agent's keeps
  its shallower history.
- **A stalled bootstrap ends the connection with no reply** — see above.
- **A second Plain client reflows the first** at the pre-resize, one step
  earlier than before this work. Known consequence of last-writer-wins sizing.
- **The relay must forward, not read.** The Server used to wait for the attach
  reply with a single frame read, so putting the bootstrap before the reply —
  which the barrier requires — silently discarded the first chunk of every
  relayed bootstrap. It now reads until it sees the reply to *its own* request
  id and forwards everything else on the terminal lane.

## Related

- [interaction-semantics.md](interaction-semantics.md) — what the client does
  with the bytes, and the four modes.
- [stream-replay.md](stream-replay.md) — the ordered timeline a bootstrap is
  deliberately not part of.
- [multi-client-ownership.md](multi-client-ownership.md) — which client owns
  input and resize while several are attached.

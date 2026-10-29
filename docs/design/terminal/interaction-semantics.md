# Terminal interaction semantics (#1096)

> Requirement: [GitHub #1096](https://github.com/BestNathan/nession/issues/1096).  
> Upstream: [terminal-surface.md](../design-system/patterns/terminal-surface.md).

One **TerminalInteractionController** owns PTY-bound bytes: keyboard (via xterm `onData`), semantic special keys (via xterm helper keyboard events), paste (`terminal.paste`), and committed IME text (`terminal.input`). UI adapters must not embed VT escape tables.

**Control bytes are data.** Every byte a terminal interaction produces reaches the PTY unchanged — `Ctrl+D` (`0x04`) included, which Nession used to read as its own disconnect. Disconnect is an explicit product action and never inferred from a byte.

**Bracketed paste is xterm's mode, not an adapter's.** Paste enters through `terminal.paste`, so the wrapping follows whatever `?2004` state the terminal is in. An adapter that wraps a paste itself would be a second, disagreeing encoder. Desktop clipboard reaches it through xterm's own textarea; mobile through `MobileImeInput`; there is no capsule paste path by design (`terminal-capsule.md` §Anti-patterns).

**The application's terminal state reaches xterm unmediated — and that is a property of the attach transport, not of this layer.** Almost everything below is a measurement of what happens when it does not, and the whole section exists so the next reader does not re-derive it.

Under `AttachMode::control` (the default, #321 S3) the agent pipes the pane's own output, so `mouseTrackingMode`, `buffer.active.type` and bracketed-paste state are **the application's**. A shell never enters the alternate screen and keeps its scrollback; a TUI enters it because it asked; `shouldScrollLocally()` (`occlusionScroll.ts`) reads a mode that distinguishes, which is what it was written for.

Under `AttachMode::plain` — still selectable, and the only mode this section's measurements are true of — tmux's *client* owns the outer terminal and does two things unconditionally on 3.6b: it enters the alternate screen (`?1049h`; `smcup@` overrides and `alternate-screen off` were measured not to prevent it) and it enables mouse reporting, because nession sets `mouse on` at Session creation. So xterm is never on its normal buffer and `mouseTrackingMode` is never `none`, and `shouldScrollLocally()` is dead code there. **The scrollback and mouse criteria are unreachable under `plain`**, which is why they are stated as Control-only rather than as an open question. `#{mouse_any_flag}` exposes the application's own request to the agent — and so do the rest of the mode flags, which is now the route that was taken: `TmuxOps::pane_mode_flags` reads them and the attach bootstrap replays them into a client that rebuilt its terminal. See [scrollback-bootstrap.md](scrollback-bootstrap.md#what-a-capture-cannot-carry).

**The deterministic fixture** (`e2e/fixtures/pty-probe.sh`) is the correctness gate: it enters a terminal mode with real DECSET and echoes the exact bytes it receives, so a browser test reads `ESC O A` as `^[OA` and `ESC [ A` as `^[[A`. Real applications are smoke tests, not the specification. Four of its six modes — `altscreen`, `bracketed-paste`, `mouse-vt200`, `mouse-sgr` — **cannot discriminate under `plain`** for the reason above; their truth lives on the tmux side there, so a browser assertion over them would pass for the wrong reason. Under `control` they do discriminate, which is what the browser coverage for them exercises.

## Clipboard protocols: OSC 52 and OSC 5522 (#2598)

Text paste stays exactly as above: it enters through `terminal.paste`, and xterm's bracketed-paste mode decides the wrapper. **Protocol clipboard is a separate path**, owned by `platform/terminal-runtime/clipboard/`. `XtermEmulator` registers the parser handlers and forwards OSC 52, OSC 5522 and private mode 5522 together with the ordered write's provenance; `ClipboardProtocol` owns the state machine and writes protocol replies through the PTY input channel.

- **OSC 52** writes text to the browser clipboard. A read (`?`) is never answered: remote output cannot read the local clipboard.
- **OSC 5522** is the Kitty MIME-aware protocol. `CSI ? 5522 h/l` enables/disables paste-event mode, `CSI ? 5522 $ p` is answered truthfully (1 set / 2 reset), and a user paste announces the offered MIME types with a one-time password. A TUI `type=read` that echoes that password receives `status=OK`, ≤4096-byte `DATA` packets and `DONE`; `type=write`/`wdata`/`walias` replace one clipboard item carrying every representation. Invalid base64/padding, packet ordering, size or concurrency produce the protocol's documented `EINVAL`/`EFBIG`/`EBUSY`/`EPERM`/`EIO` replies, and an errored write stays discarded until a new `type=write`.
- **Provenance is the ordered writer's, not React's.** `SerializedTerminalWriter` carries `{source: live|replay, streamEpoch}`; bootstrap/replay writes and frames from a superseded epoch never cause a clipboard effect or paste announcement.
- **Authority is the Controller lease, not attach.** Only an authorized, foreground (visible) client may perform an effect; an observer performs none and sends no protocol replies. A read requires the one-time password minted by that client's own user paste.
- **No upload fallback.** Image bytes travel only as OSC 5522 MIME data through the PTY. A TUI that has not enabled 5522 gets no image data; an image-only paste is not sent, and the surface states that the protocol is unsupported.

### Ordinary HTTP is not a secure context (#2614)

The deployed staging origin is plain HTTP, where browsers do **not** expose the async Clipboard API. The protocol stays truthful there: an automatic OSC 52 or OSC 5522 **write** cannot complete, and the protocol answers `EPERM` rather than pretending an effect happened (an OSC 52 frame produces the actionable copy state instead of a silent write). The supported paths on HTTP are the user's own gestures:

- The copy notice's action runs `document.execCommand('copy')` with a scoped `copy` listener **inside the click**. It must not await `navigator.clipboard` first: on HTTP that call cannot exist, and on a secure origin the await would spend the activation the DOM copy needs. If the browser refuses the command, the notice presents a bounded, read-only, selectable surface and states that the copy was not automatic — never a false success.
- Text paste and OSC 5522 image ingress enter through the browser's native `paste` event and `ClipboardEvent.clipboardData` (`DataTransfer.items`, `File.arrayBuffer()`), which are not secure-context gated. `navigator.clipboard.read()` is never used.

So HTTPS is not a prerequisite for clipboard usability: it is a prerequisite only for **programmatic** clipboard access. The matrix is: on HTTP, native text paste, image ingress to a 5522-negotiated TUI and user-gesture text copy work; automatic remote OSC 52/5522 writes and OS image writes do not.

**Out of scope here:** multi-client resize authority (#1095), durable replay (#1094), and the attach bootstrap and local scrollback sourcing ([#321](https://github.com/BestNathan/nession/issues/321)).

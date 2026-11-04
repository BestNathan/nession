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

### Ordinary HTTP is not a secure context (#2614, #2656)

The deployed staging origin is plain HTTP, where browsers do **not** expose the async Clipboard API. Clipboard writes still enter the one shared browser owner (`shared/lib/clipboard`, which integrates `copy-to-clipboard`):

- **Automatic OSC 52 text** invokes the shared library's synchronous legacy `execCommand('copy')` path without requiring a user click. Chromium may permit it; the browser's actual result decides. A completed write is silent (no notice); a refusal produces the existing actionable Copy notice. A remote emission cannot manufacture user activation, so Firefox/Safari policy may still refuse.
- **OSC 5522 binary/MIME writes** are explicitly refused on HTTP (`EPERM`) because the text fallback cannot carry arbitrary representations; the protocol's existing notice/behavior is preserved.
- **User-gesture text copy** — ordinary UI and the copy notice's action — invokes the same shared owner inside the click. On HTTP the library's hidden-selection command runs before its Promise settles; on a secure origin it uses the async API. A caller must not await unrelated work first, and a refusal shows the bounded selectable surface rather than a false success.

Text paste and OSC 5522 image ingress still enter through the browser's native `paste` event and `ClipboardEvent.clipboardData` (`DataTransfer.items`, `File.arrayBuffer()`), which are not secure-context gated. `navigator.clipboard.read()` is never used.

HTTPS is required for the async Clipboard API and binary OSC 5522 writes. It is not required for user-gesture text copy, native paste/image ingress, or the automatic OSC 52 legacy attempt: on HTTP those work when the browser permits, and every result is reported truthfully.

## Touch scrolling (#2659)

A single-finger vertical drag scrolls the terminal, and which answer that is comes from the mode xterm already tracks — the same question `shouldScrollLocally()` answers for a desktop wheel:

- **Normal buffer with scrollback and no mouse tracking** — the drag moves xterm's local viewport. `CapsuleOcclusionScroll` takes it with `preventDefault` and calls `scrollLines`, so the PTY sees nothing and the follow/history layout mode moves with the viewport.
- **Mouse-reporting TUI, or the alternate screen** — the drag is re-dispatched as a `wheel` event on the terminal element, which is xterm's own wheel path: a mouse-reporting application receives the standard wheel mouse report, and the alternate screen gets xterm's answer (there is no local history to take). The touch handler never synthesises application-specific sequences.
- **Not claimed:** a horizontal drag (the App edge pager and terminal selection keep it — the axis is locked at the 8px slop and never re-opened mid-gesture), a second finger, and a tap. No `preventDefault` is called for those, so their owners receive the gesture unchanged.

Vertical travel accumulates in pixels and emits whole lines (16px cell = one line in the fixtures), carrying the remainder: a high-frequency touch stream must not turn each 1px move into a line jump. Sub-slop movement before the axis is decided is absorbed.

## Terminal Keys chords (#2710)

Terminal Keys is a key surface, not a second interaction model. A direct key
(Esc/Tab/Space/Enter/Delete/arrows) is a semantic key: the interaction runtime
encodes it from the terminal's current modes, so DECCKM still decides an
unmodified arrow's bytes.

A **one-shot modifier** (Ctrl/Alt/Shift) is panel state, not a terminal keypress.
Selecting one sends nothing and opens the A–Z selector; the next compatible key
produces **one atomic chord** through `TerminalInteractionController.sendChord`
and clears the modifier. Cancel clears it without a write. The mapping mirrors
xterm's own keyboard evaluator for the exposed set: Ctrl+letter is the C0
control byte, Alt+letter the ESC-prefixed meta form, Shift+Tab `CSI Z`, and a
modified cursor/Delete key the mode-independent `CSI 1;<modifier>` form. The UI
holds no escape table.

There is no key chain. The old long-press chain accumulated keys and sent them
one after another, which is not a chord; it is retired, and ordinary taps keep
their existing path. Chords are owned by the interaction runtime, so a UI
adapter cannot invent an escape string, a sequential write, or an IME-dependent
keydown.

## Upper-panel scroll clearance (#2710)

The capsule docks two clearances, and they are not interchangeable:

- **fit occlusion** — `--nession-local-terminal-capsule-occlusion`, measured
  from the composer shell. It becomes the terminal viewport's bottom inset and
  therefore changes xterm rows and the PTY size. An upper surface must never
  enter this value.
- **scroll clearance** — `--nession-local-terminal-capsule-panel-clearance`,
  measured from the *highest open surface* (the Context Capsule, Terminal Keys,
  Quick Commands, or another Peek). `CapsuleOcclusionScroll` spends it as a
  visual `translateY` of the rendered `.xterm-screen`: the live bottom moves
  above the panel, while the grid, PTY, tmux pane and cursor coordinates stay
  exactly what the composer-only fit decided.

The scroll owner applies the shift only in the normal local buffer with no
mouse tracking. In following state it keeps the live bottom above the panel; in
history it applies no shift, so the browsing anchor survives a panel height
change, and scrolling back to the live bottom restores the clearance. An
alternate-screen or mouse-reporting application owns its own screen geometry and
is never shifted. Closing the panel returns the clearance to zero without moving
a history position.

## Touch direction pad (#2657)

A stationary single-finger hold inside the Terminal viewport arms a compact four-direction dial. The gesture is a **terminal input accelerator**, not cursor repositioning: each direction is forwarded as the semantic key a physical arrow would produce, through `TerminalInteractionController.sendSemanticKey` (via `TerminalController.sendPhysKey`). The pad never writes ANSI bytes, fakes a `KeyboardEvent`, moves the local xterm cursor, or bypasses the input lease, so application cursor-key mode (DECCKM), `onData`, the observer gate and the existing Terminal Keys path all apply unchanged.

- **Before arming** (≈380 ms): nothing is prevented or stopped. A tap, a quick swipe, native scrolling, the App's edge pager and text selection keep their gestures. A pending touch that travels past ~12 px is surrendered to whichever native gesture won.
- **After arming**: the pad claims the tracked `Touch.identifier` in the shared ownership registry and consumes every move, end and cancel for that finger. It registers a non-passive capture-phase move listener, calls `preventDefault()` and `stopImmediatePropagation()`, suppresses the compatibility click, and locks the terminal scrollback offset for the gesture. `useSwipePager` and `CapsuleOcclusionScroll` consult the registry rather than relying on listener registration order, so a shell or scroll owner that started earlier stands down.
- **Direction**: a ~24 px enter / ~17 px exit centre dead zone and a 1.28 axis preference stop diagonal chatter. Returning to the centre stops repetition; leaving it again emits one new key.
- **Repeat**: the clock is anchored to the last **emitted key**, not the last touchmove, at 1/2/4/8 keys per second across ~48/76/108 px with ±5 px band hysteresis. A speed change re-anchors the next tick and never emits an immediate extra key; a late timer emits at most one key, so a suspended tab or a frame stall cannot produce a burst.
- **Release/cancel**: end, cancel, a lost input lease (observer/reconnect/route switch), visibility loss, `pagehide`, a second finger or unmount stops the clock, drops the claim and removes the guide. The browser's long-press callout is suppressed only while the pad owns the finger; ordinary long-press semantics and pinch are not disabled globally.
- **Target lifetime**: a native touch keeps targeting the element that received `touchstart`. Production touches land on xterm's canvas/screen node, which persists across buffer updates; the adapter also watches the initiating target and cancels if it leaves the document (for example a renderer swap), rather than leaving a gesture with a lost end.

The dial is transient and non-interactive (`pointer-events-none`); Terminal Keys remain the visible, keyboard-reachable fallback. The App's 28 px edge band stays shell navigation's: the App layer supplies the exclusion predicate, and the pad never arms inside it.

**Prototype:** the interaction was approved from the pinned mobile mock at `6f5abbf02395390deb933c0a8478eb17d593a4c6` on the shared `prototype` branch (issue #2657, product review 2026-11-03). The production implementation preserves its decisive invariant — the initiating touch target stays connected for the whole gesture — while the mock itself is not production code.

**Out of scope here:** multi-client resize authority (#1095), durable replay (#1094), and the attach bootstrap and local scrollback sourcing ([#321](https://github.com/BestNathan/nession/issues/321)).

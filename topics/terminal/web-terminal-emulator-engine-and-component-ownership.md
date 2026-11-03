---
title: "Web terminal emulator engine and component ownership"
description: "One Xterm Engine owns the raw @xterm/xterm instance, OSC 52/5522 clipboard parsing, the non-reserving status overlay and mode-owned touch scrolling; Product/UI consumes a narrow emulator port"
topic: terminal
categories: ["architecture","ownership","terminal","web"]
status: verified
created_at: 2026-10-28T17:46:56Z
updated_at: 2026-11-03T08:46:49Z
sources: ["https://github.com/BestNathan/nession/blob/df39f65fec7825903d1f9f0f87c6c63dffb03e1d/docs/architecture/terminal-engine.md","https://github.com/BestNathan/nession/blob/d4dd4d4e3dbbbe8473fa3277eb38d02ba3799249/docs/architecture/terminal-engine.md","https://github.com/BestNathan/nession/blob/bccd9928983ab2818a34e36cdd16d015966f7100/docs/design/terminal/interaction-semantics.md","https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/design/terminal/interaction-semantics.md","https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/web/src/platform/terminal-runtime/capsule/occlusionScroll.ts","https://github.com/BestNathan/nession/blob/deb647ec128576b722d7b390c084b4614db9e23a/docs/design/design-system/patterns/terminal-capsule.md","https://github.com/BestNathan/nession/blob/7c816a909d1d748cf8c36cec934421b090a1309c/docs/design/design-system/patterns/terminal-surface.md","https://github.com/BestNathan/nession/issues/2598","https://github.com/BestNathan/nession/issues/2614","https://github.com/BestNathan/nession/issues/2621","https://github.com/BestNathan/nession/issues/2659","https://github.com/BestNathan/nession/issues/2663","https://github.com/BestNathan/nession/pull/2583","https://github.com/BestNathan/nession/pull/2678"]
---

# Web terminal emulator engine and component ownership

## Decision

Nession's Web terminal has one business-neutral **Xterm Engine** in
`web/src/platform/terminal-runtime/xterm/`. `XtermEmulator` is the only
production owner of an `@xterm/xterm` `Terminal`: it constructs the instance,
mounts/reparents/unmounts it without destroying the buffer, installs the
renderer/theme/addon lifecycle, and maps logical-line text offsets to buffer
cells. `XtermMetrics` is the single compatibility adapter allowed to read
xterm's private `_core` render service.

Product/UI consumes the port in `platform/terminal-runtime/emulator.ts`:
typed disposables, buffer/mode/cursor read models, bounded font configuration
and a link matcher. It does not import `@xterm/*`, does not import the engine
adapter module, and has no raw-terminal escape hatch.

The surrounding correctness owners are unchanged and are not duplicated by the
engine: `SessionRuntime` owns route/attach/lease/stream synchronization,
`SerializedTerminalWriter` owns ordered buffer/grid mutation,
`TerminalGeometry` owns fixed-column font/rows policy,
`TerminalInteractionController` owns PTY-bound input semantics, and Product
owns Workspace file-link recognition and navigation.

The engine also owns the terminal clipboard **protocol** surface
([#2598](https://github.com/BestNathan/nession/issues/2598)). Every OSC 52 and
OSC 5522 parser registration — OSC 52, OSC 5522, `CSI ? 5522 h/l` and
`DECRQM 5522` — lives in `xterm/XtermEmulator.registerClipboardHost`; the
state machine is xterm-free in `clipboard/ClipboardProtocol.ts` and the
browser adapter is `clipboard/browserClipboard.ts`.
`TerminalController` is the authority gate: effects run only for the attached,
non-observer, document-visible client, and only when the ordered writer marks
the frame as live at the newest stream epoch (bootstrap/replay frames carry a
`replay` origin and are rejected). tmux reaches the same bytes on both
transports because the shipped server config
(`crates/nession-agent/src/tmux/cmd.rs`) sets `set-clipboard external` and
`terminal-features ',*:clipboard'`, and the tmux client pins
`TERM=xterm-256color` so plain attach forwards OSC 52/5522. Image clipboard
data travels only through the negotiated in-band protocol: there is no
FilesPlugin, upload, remote-file or path conversion, and an unnegotiated
image-only paste becomes an honest status-strip message instead.

The Terminal Surface's status chrome is part of the same boundary
([#2621](https://github.com/BestNathan/nession/issues/2621)). History-degraded,
input-drop, clipboard and observer notices all render in one root-owned,
absolute overlay (`TerminalStatusOverlay` in
`product/terminal/patterns/TerminalSurface.tsx`) that is a sibling of — never a
child of, and never a flex participant with — `[data-terminal-capsule-host]`.
The host stays the only flex-filling region, so the xterm grid and viewport are
identical when a notice appears, is replaced or expires. The overlay keeps the
measured #1307 rule that status is never painted under the opaque bottom
capsule: a `pointer-events-none` layer with compact `pointer-events-auto`
content-width pills at the top end.

The clipboard paths split by origin capability, not by protocol
([#2614](https://github.com/BestNathan/nession/issues/2614)). The deployed
staging origin is plain HTTP, where browsers do not expose the async Clipboard
API. Automatic OSC 52/5522 **writes** therefore cannot complete there and the
protocol answers truthfully (`EPERM`); the notice's Copy action decides the
capability synchronously and, without the async API, runs
`document.execCommand('copy')` with a scoped `copy` listener inside the click —
never an awaited `navigator.clipboard` call, which would spend the activation
before the DOM copy could run. If the command is refused, the notice offers a
bounded read-only selectable surface and says the copy was not automatic.
Native text paste and OSC 5522 image ingress are **not** secure-context gated:
they enter through the browser's `paste` event (`ClipboardEvent.clipboardData`,
`File.arrayBuffer()`), never `navigator.clipboard.read()`. HTTPS is therefore a
prerequisite for *programmatic* clipboard access only, not for clipboard
usability.

The Capsule composer's **work state** follows the same ownership rule
([#2663](https://github.com/BestNathan/nession/issues/2663)). The resting `+`
is one plain trigger in every lifecycle state: no Work Ring, badge, spinner,
pulse or reserved ambient slot, and no second decoration in its place. A
capability's work contribution flows only through the generic seam
(`app/workSignals.ts` → `resolveWorkContext` → the disclosed Context Capsule's
sensed rows); with no verified activity producer, the production binding list
is empty and the resting composer draws nothing. Presence is not work: a
foreground `claude`/`claude.exe` proves the CLI is open in the Session and may
resolve the capability to `active`, but it must not manufacture a `working`
status or the former "Working in this session" copy. The 2026-11-03 owner
decision supersedes #1347's static ambient Work Ring rule; the old ring
acceptance and its screenshots remain historical evidence.

Capsule **touch scrolling** is a mode question, not a second scroll
implementation ([#2659](https://github.com/BestNathan/nession/issues/2659)).
`CapsuleOcclusionScroll` listens on the capsule host in the capture phase — so
a claimed gesture pre-empts xterm's own `Viewport` touch listeners, which bind
on `.xterm` — decides the axis at an 8px slop, accumulates vertical travel in
pixels and emits whole lines with the remainder carried. In the normal buffer
the drag moves xterm's local viewport (`scrollLines`) and the PTY receives
nothing; in a mouse-reporting TUI or the alternate screen it re-dispatches a
synthetic `wheel` event on the terminal element, so xterm's existing wheel path
answers (a standard wheel mouse report, or xterm's no-scrollback answer) and
the handler never synthesises application-specific sequences. A horizontal
drag (the edge pager and selection keep it, and the axis stays locked for the
gesture), a second finger and a tap are not claimed, so their owners receive
the gesture unchanged.

## Context and evidence

- Requirement: [#2581](https://github.com/BestNathan/nession/issues/2581);
  implementation PR [#2583](https://github.com/BestNathan/nession/pull/2583).
- Canonical architecture: `docs/architecture/terminal-engine.md` at
  `df39f65fec7825903d1f9f0f87c6c63dffb03e1d` (writable-owner table, final
  dependency graph, test owners).
- `nession/no-direct-xterm` enforces the boundary: no `@xterm/*` outside the
  engine, no engine-module import from Product/UI, `_core` only in
  `XtermMetrics.ts`. Negative fixtures prove each rejected shape.
- Geometry only refits the font when the observed width changes; a height-only
  observation reuses the measured cell. The ordered writer drops a resize that
  repeats the grid it already applied, while keeping the operation in FIFO
  position so its parser-completed callback cannot overtake an earlier write.
- Workspace-link cell mapping is proved for ASCII, wide characters, combining
  sequences and wrapped continuations; out-of-range matches are dropped rather
  than clamped.
- The canonical fixture constructs through the engine's public barrel, so
  fixture and product terminal construction share the renderer/theme/metrics
  rules.
- Clipboard protocols merged at `d4dd4d4e3dbbbe8473fa3277eb38d02ba3799249`;
  canonical design state is
  `docs/design/terminal/interaction-semantics.md` (“Clipboard protocols”),
  `docs/design/design-system/patterns/terminal-surface.md` (transient states),
  `docs/design/terminal/multi-client-ownership.md` (Clipboard authority) and
  the `docs/architecture/terminal-engine.md` owner table.
- Proof at the merged ref: 31 protocol unit tests (strict base64, chunking,
  `EINVAL`/`EFBIG`/`EBUSY`/`EPERM`/`EIO`, one-time reads, the 64 MiB Kitty
  minimum write), real-parser xterm binding tests, controller authority/
  provenance tests, UI status-strip tests, the tmux server-config test, and
  terminal-io E2E. Staging Acceptance recorded Pass for SC-01..SC-11 at
  `1de6185df91526b6561fed6dce048c59eeb6abe7` (runs 40852433372 and
  40853260244).
- Status overlays merged at `7c816a909d1d748cf8c36cec934421b090a1309c`; the
  canonical rule is the “No Terminal height reservation” paragraph in
  `docs/design/design-system/patterns/terminal-surface.md`. The four inputs
  are reachable from `/fixture/app` and `/fixture/clipboard` (`?history=`,
  `?drop=`, `?role=`, `?clipboard=`). Measured App 390x844 and Web 1280x800:
  rows, columns, capsule host, viewport and surface boxes are unchanged for
  each notice and for all four at once, and after the clipboard notice expires.
  Staging Acceptance recorded Pass for SC-01/SC-02/SC-03 at
  `176fa0ec92509227fd413c70f6f625d5d4d90307` (run 40892078393) and SC-04 at
  `04e62467d1255121cda8ddd96e9a25147fb49828`.
- HTTP clipboard capability merged at
  `bccd9928983ab2818a34e36cdd16d015966f7100`; the canonical matrix is the
  “Ordinary HTTP is not a secure context” section in
  `docs/design/terminal/interaction-semantics.md`. Proof: the browser Cases
  serve the exact-SHA build from a real non-loopback HTTP origin
  (`isSecureContext=false`, no `navigator.clipboard`). SC-01/SC-03/SC-04 Pass
  at staging `5166e9e588f84103a28cd5d89fa437a3667d8ede` (run 40936550084);
  SC-02/SC-05 Pass at `f255256741e0dc488d830ede98a8caf1933e76b0` against the
  authenticated staging deployment attestation (runs 40934579327, 40934973435),
  including a 5522 image SHA-256 match with zero secure-context API use and a
  DOM copy event carrying the exact text.
- The plain-`+` decision merged at
  `deb647ec128576b722d7b390c084b4614db9e23a`; the canonical rule is the
  “resting `+` carries no work state” section in
  `docs/design/design-system/patterns/terminal-capsule.md`. Proof: SC-01
  (identical trigger markup/box/icon for idle and `claude.exe`-open on Web and
  App, zero ring nodes and zero animation), SC-02 (disclosure open/close,
  keyboard, Escape, outside pointer, focus return, every Peek) and SC-03
  (active presence without a work claim; production bindings emit no signal)
  Pass at staging `276e046f1ba1b345b6e80635648febd43730658a` (run
  41592140794); SC-04 Pass at `589bdf51d7008d3f92351decff95ea4b83e1c36a`.
  The CLI-open disclosure baseline is `app-cli-open-context-disclosure.png`.
- Touch scrolling merged at
  `dab5685f536722069e3c6c62ff112d8abae3e1a5`; the canonical rule is the “Touch
  scrolling” section in `docs/design/terminal/interaction-semantics.md`, and
  the handler is
  `web/src/platform/terminal-runtime/capsule/occlusionScroll.ts`. Proof: the
  source-aligned Cases record Pass for SC-01..SC-04 at staging
  `705d511b6db150ebd7a03bf9e113a88deb72237a` (run 41601652472) — one cell of
  drag moved exactly one local line with no PTY bytes, a mouse-reporting TUI
  received the SGR wheel report, the alternate screen received xterm's
  no-scrollback wheel answer, and horizontal/multitouch/tap gestures produced
  no input; 23 source tests cover the gesture state machine and the three
  modes. Staging rolled out `ceee96d579c35fb7f66582142e38fc893d1cf144`, which
  contains the merged fix.

## Related knowledge

- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md)

## Limits / when to revisit

- This article covers the Web/xterm component boundary only. Backend tmux SDK
  work remains owned by #2469; session transport and stream recovery remain
  owned by #1309/#1645; lease/observer semantics remain owned by the
  multi-client ownership design.
- Clipboard protocol scope is text OSC 52 writes plus OSC 5522 read/write with
  text or images. OSC 52 reads stay disabled by default; file transfer,
  FilesPlugin coupling and app-specific (Claude/Codex) adapters are explicitly
  out of scope — revisit only through a new owner decision.
- On plain HTTP only user gestures can write the clipboard: do not add a
  programmatic fallback (Chrome flags, hidden iframes, permission prompts) and
  do not mark the copy successful without the browser's own confirmation. The
  manual-copy surface is bounded (64 KiB); a larger payload is refused honestly
  rather than truncated.
- Do not reintroduce an ambient work marker around the resting composer. A
  future verified activity signal belongs to the `CapabilityWorkBinding` seam
  and enriches the disclosed Context Capsule; process presence is never proof
  of work, and the `+` must not reserve a slot for one.
- Touch scrolling must keep deciding ownership from the mode xterm already
  tracks; do not add a parallel buffer-scroll path for mouse-reporting or
  alternate-screen modes, and do not claim horizontal, multitouch or tap
  gestures. Sub-cell accumulation plus the slop/axis lock are what keep a
  high-frequency touch stream from jumping lines or stealing the App edge
  pager; the listener must stay in the capture phase on the capsule host so a
  claimed gesture pre-empts xterm's own touch scroll instead of racing it.
- Revisit if xterm's private render-service shape changes (the negative fixture
  and `XtermMetrics` are the compatibility point), if a second raw xterm
  consumer appears outside the engine, or if Addon/link ownership moves.
- A new Terminal status type must reuse the same root-owned overlay; a second
  footer or any full-width in-flow status band re-opens #2621 (and a
  capsule-band placement re-opens #1307). Status chrome is presentation only:
  protocol, authority and provenance rules stay with the clipboard protocol,
  `SerializedTerminalWriter` and `TerminalController` owners.
- The engine is internal to `platform/terminal-runtime/xterm/`; there is no npm
  package extraction decision.

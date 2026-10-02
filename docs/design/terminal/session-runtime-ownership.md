# Terminal session runtime ownership (#1309)

> Requirement: [GitHub #1309](https://github.com/BestNathan/nession/issues/1309).

The **SessionRuntime** (`web/src/platform/session-runtime/`) is the single
writable authority for one session's terminal transport and attach lifecycle:
route state, attach state, and I/O state have exactly one owner, and React
consumes the result as a read-only snapshot projection. This doc records the
final ownership boundary and event flow; it is the upstream constraint for any
change that touches terminal attach, reconnect, relay fallback, or transport
wiring.

```text
                  SessionRuntime  (the only writer)
                       |
      +----------------+----------------+
      |                |                |
   route state      attach state     I/O state
  (address policy,  (AttachStateMachine  (agent ws, relay
   candidate index,  + SessionAttach-     handle, live
   relay fallback)   Controller)          transport binding)
      |                |                |
      +----------------+----------------+
                       |
        immutable snapshot + typed events (out only)
                       |
            +----------+----------+
            |                     |
        React UI             TerminalController
      (projection only:    (viewport/xterm only:
       useSyncExternalStore  reports viewport facts
       on getSnapshot)       up; decides nothing)
```

## Runtime-owned facts

These facts live inside the runtime and nowhere else (no Jotai mirror, no
React state that could feed them back):

- selected route / candidate index and the manual-override verdict;
- live transport identity (`buildTransport()` + `subscribeTransportSwap`);
- agent-transport connection state;
- attach phase (`AttachStateMachine`, observed via the snapshot);
- the dynamic relay fallback (see below);
- reconnect attempt count and budget (the attach state machine's);
- transport generation;
- viewport readiness (`setTransportReady`) and the authoritative viewport
  size (`updateViewportSize`);
- the P2P attach seed (stream/input cursors stated by the attach reply).

React keeps **UI/application state only**: which session is selected, the
attach intent (`attachInfoAtom`), the user's manual route choice
(`manualOverrideAtom`), and the route-intent epoch (`routeIntentEpochAtom`)
that *tells* the runtime the intent changed. These are inputs the runtime
reads via `updateContext`; they are never a second copy of a runtime fact.

## Event flow

```text
runtime event  (socket state, attach reply, probe verdict, context update)
-> runtime transition  (synchronous, inside the runtime)
-> bind/swap transport (buildTransport + swap notification)
-> publish one snapshot (value-compared; no emission when equal)
-> React renders the result
```

The reverse flow is forbidden: no `runtime → atom → effect → epoch bump →
transport rebuild` round trip. Correctness never depends on React effect
ordering; the same transitions are driven in unit tests without React at
all (`platform/session-runtime/__tests__/unit/SessionRuntime.test.ts`).

Selection is a **construction fact**: a runtime is created because a session
was selected, and its constructor dispatches `SESSION_SELECTED`. A runtime
that outlives its React tree (registry lease) never re-selects.

## The transport-binding invariant

```text
a TerminalTransport created for generation N
must never bind to generation N-1's Agent API
```

Structural, not procedural: `buildTransport()` reads the mode and the agent
API from the runtime in one call, so a transport carries the generation it
was built at; and the swap notification is posted only **after** the new
identity (socket, agent API, handlers) is fully installed — a binding
rebuilt inside the notification cannot capture the disposed generation.
Proven by non-React tests (`transport binding (#1309)`).

## Generation vocabulary — no universal epoch

Four generations exist, each answering a different "is this stale?":

| Generation | Bumped by | Guards |
|---|---|---|
| `routeIntentEpoch` | the user (route switch, explicit→Auto) | clears the relay fallback, resets the candidate index, rebuilds the connection |
| `transportGeneration` | candidate rotation, route change, relay flip | dedupes attach starts; pairs the live transport with the attach that succeeded on it |
| attach epoch (`SessionAttachController`) | cancel/supersede of an in-flight attach | a late attach resolution (dispose rejection or stale ok) is a no-op |
| probe token | probe disarm (teardown, loss) | a pong deadline expiring after the transport moved on cannot declare the replacement dead |

A stale resolution from an old generation can never mutate the current
runtime (SC-10), and each guard is pinned by a test whose named mutation
fails (`stale resolutions from an old generation (#1309 SC-10)`).

## The relay fallback is a runtime verdict, not a config value

`forcedRelay` in the config is **static intent** (the attach choice was not
P2P). The dynamic fallback — every P2P candidate failed, so the session
continues through the server — is owned by the runtime
(`forcedRelayFallback`, published as `snapshot.forcedRelay`). It is set only
by the runtime's own exhaustion/attach-error paths and cleared only by a new
route intent or a fresh address plan. A steady-state `updateContext` sync
must never clear or set it — that round trip is the clobber class this
split removes.

The runtime also owns the relay's end: `dispose()` ends the server-side
relay forwarding (best-effort, only against a ready connection). Disposal
covers every leave — disconnect, session switch, unmount — so an end can no
longer be forgotten by a callback chain that was never wired (the dead
`onDisconnect` chain this requirement deleted, SC-08).

## StrictMode

The registry leases runtimes by reference count and defers disposal one
macrotask, so a StrictMode mount → cleanup → mount re-acquires the same
runtime instead of disposing and rebuilding it: one socket, one attach, no
`endRelay` from a transient unmount. Measured on the shipped React build,
the replay only fires when `<StrictMode>` is the **root element** of the
render call — a StrictMode inside a `renderHook` wrapper never replays, so
the StrictMode tests render a harness component as `StrictMode`'s direct
child. Each asserts an effect the replay would produce (socket count,
attach frames, `dispose`, `endRelay`), not a rendered value — the replay's
intermediate states batch away and an identity check on the hook's return
cannot see a dispose-and-rebuild.

## Controller and I/O boundaries

- **TerminalController** owns TerminalInstance/xterm, the input router,
  resize measurement, local scrollback/render, bootstrap/output apply, and
  viewport attach/detach. It reports viewport facts (readiness, size) to the
  runtime and decides nothing about route, reconnect, fallback, attach, or
  retry budgets.
- **ConnectionManager / the transports** own I/O adaptation only: send,
  resize, ordered stream apply, input buffering against the attach gate.
  The transport-interface surface carries only members with a real producer
  and a real consumer — the never-fired `onDisconnect`/`onStateChange`
  chain was deleted rather than documented (SC-08).
- **Retry phases are stable**: the attach state machine stays in one
  `connecting`/`reconnecting` phase per attempt budget and never toggles
  phases to trigger external work (SC-07); the runtime's self-driving retry
  re-sends `client.attach` on the state machine's timeout outcome.

## Snapshot contract

`getSnapshot()` is a cached, value-compared projection consumed through
`useSyncExternalStore`: identical inputs produce an identical (===) snapshot
and emit nothing, so the projection cannot create a feedback render loop
(SC-14). Imperative read-backs (attach flow guards, route guards) read
`sessionRuntimeRegistry.get(sid)?.getSnapshot().phase` instead of a Jotai
mirror.

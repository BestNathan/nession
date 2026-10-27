import type { AttachInfo } from '@/types';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';
import { buildAgentWsUrl, WebSocketService } from '@/platform/socket';
import type { ConnectionState, HandshakeSurface, SentSocketMessage } from '@/platform/socket/types';
import { getOrCreateClientId } from '@/platform/socket/clientId';
import { WIRE as CLIENT_AUTH_WIRE, type AuthResponsePayload } from '@/generated/protocol/core/client-auth/v1';
import { AddressAttachPolicy } from '@/platform/attach/AddressAttachPolicy';
import { AttachStateMachine, type AttachPhase, type AttachTransitionResult } from '@/platform/attach/AttachStateMachine';
import { SessionAttachController } from '@/platform/attach/SessionAttachController';
// Types only, like the capability factories below: the runtime decides WHEN a
// transport is built and with WHICH identity, but the concrete transport is the
// caller's — `createTransport` is injected for the same reason
// `createTerminalAgentApi` is (#783), and a value import of ConnectionManager
// here would put terminal-runtime's construction details into the layer that
// owns none of them.
import type { ConnectionOptions } from '@/platform/terminal-runtime/types';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { InputDrop } from '@/platform/terminal-runtime/inputQueue';
import {
  AppliedTerminalCursor,
  type AppliedCursorBinding,
  type AppliedCursorSnapshot,
  type VerifiedTerminalBaseline,
} from '@/platform/terminal-runtime/AppliedTerminalCursor';
import type { TerminalStreamPosition } from '@/platform/terminal-runtime/streamApply';
// Types only. The capability *factories* are injected through
// SessionRuntimeConfig instead of imported, because `platform` sits below
// `product` and `capabilities` and may not import either — while the runtime is
// genuinely below the terminal concept, which consumes it (#783). This was
// written when the module lived at `runtime/` and the layer was called `core`;
// the constraint is the same one, and it is why the type-only imports below are
// legal while a value import of the same modules would not be.
import type { FilesPlugin } from '@/capabilities/files';
import type { TerminalAgentApi, RelaySubscriptionProof } from '@/product/terminal';

export interface SessionRuntimeConfig {
  sessionId: string;
  sessionName: string;
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  /**
   * The STATIC relay intent (the attach choice was not P2P). The dynamic
   * fallback — every P2P candidate failed, so the session continues through
   * the server — is runtime-owned state on top of this, never a config round
   * trip: carrying the effective value here let a stale React-side `false`
   * clobber the runtime's own fallback on every updateContext (#1309 SC-02).
   * The effective mode is `forcedRelay || internalFallback`, published on the
   * snapshot.
   */
  forcedRelay: boolean;
  /** Ordered candidate URLs, best-first (#1430: resolved synchronously). */
  addressUrls: string[];
  /** User-initiated route identity (manual switch); resets candidate index when changed. */
  routeIntentEpoch: number;
  /**
   * Relay-mode server connection — runtime re-begins relay after server
   * reconnect. The full transport shape rather than the narrow handle because
   * the runtime hands it to the relay transport it builds; the runtime itself
   * still uses only the lifecycle members.
   */
  serverConnection?: RelayServerTransport | null;
  /**
   * Capability factories the runtime needs for a P2P attach.
   *
   * Injected rather than imported: `platform` may not import a `product`
   * module, but the terminal concept needs the runtime, so the dependency has
   * to point one way. The caller — `product/terminal`, which owns both — hands
   * them over. See #783.
   */
  createFilesApi: () => FilesPlugin;
  createTerminalAgentApi: (ws: WebSocketService) => TerminalAgentApi;
  /**
   * Build the session's I/O transport from runtime-owned facts (#1309).
   *
   * The runtime calls this inside {@link SessionRuntime.buildTransport} with
   * the mode, identity and callbacks it owns; the caller (product/terminal)
   * turns that into the concrete ConnectionManager. Injecting it keeps the
   * runtime free of terminal-runtime construction details while making the
   * runtime the single authority that decides when a transport exists and
   * which agent API it binds — the property the transportEpoch effect used to
   * approximate from React.
   */
  createTransport: (opts: ConnectionOptions) => TerminalTransport;
  /**
   * Told when input the user typed is lost rather than delivered (#1307
   * SC-09). The runtime routes the fact from the transport it built to the
   * product surface that states it; the runtime itself keeps no copy.
   */
  onInputDrop?: (drop: InputDrop) => void;
  /**
   * Whether the Terminal already holds this session's history (#321).
   *
   * A **reader**, not a flag, and deliberately: the xterm outlives this runtime
   * (a rewire rebuilds the runtime under a surviving Terminal), so a value
   * latched here could say "empty" about a buffer that is full — and the cost
   * of being wrong in that direction is the user seeing their history twice.
   * Asking the Terminal keeps one authority for a fact about the Terminal.
   *
   * Absent means "no" — ask for a bootstrap. That is the safe direction for a
   * consumer with no Terminal to ask (the CLI's own `attach_frame` makes the
   * same choice for the same reason), and it is visible in a test rather than
   * silently suppressing history.
   */
  hasSessionOutput?: () => boolean;
  /**
   * Whether the **renderer mounted now** parsed a capture of this session
   * (#2194).
   *
   * `hasSessionOutput` answers "does the Terminal hold any output"; that is
   * true for a replacement renderer as soon as live frames reach it, which is
   * before any attach and therefore before any capture. A renderer that only
   * ever saw live output holds no history: attaching without asking for one
   * starts a new timeline silently. This reader is the narrower question and
   * the one attach must ask.
   *
   * A reader rather than a flag for the same reason as `hasSessionOutput`: the
   * renderer can be replaced under a surviving runtime, so only the Terminal
   * can answer. Absent means "assume it does" — the pre-#2194 behaviour for
   * consumers that have no Terminal to ask (and for tests that predate the
   * distinction).
   */
  hasSessionHistory?: () => boolean;
}

export interface RuntimeMirrorSnapshot {
  phase: AttachPhase;
  transportGeneration: number;
  connectionState: ConnectionState;
  /** Agent terminal capability — null outside the P2P transport. */
  agentTerminalApi: TerminalAgentApi | null;
}

export interface SessionRuntimeSnapshot extends RuntimeMirrorSnapshot {
  sessionId: string;
  activeUrl: string | null;
  /**
   * The EFFECTIVE relay mode: static intent OR the runtime's own fallback
   * (#1309 SC-02). This is the only place the fallback is published — React
   * consumers derive the effective mode from it instead of mirroring it into
   * an atom of their own.
   */
  forcedRelay: boolean;
  transportReady: boolean;
  lastResize: { cols: number; rows: number } | null;
  reconnectCount: number;
  /**
   * The runtime noticed output it cannot prove it received (#2155): a lost
   * transport whose replay cannot reach back, a truncated stream, or a hole a
   * replay gave up on. This is the **observed gap** fact — not "needs a
   * bootstrap" (a fresh attach asks for history without a hole) and not
   * "recovery proven" (cleared only by a complete repair). The surface shows
   * a quiet notice while it is true.
   */
  historyDegraded: boolean;
  /**
   * The explicit tri-state the UI and tests read (#1926 SC-08).
   *
   * `attached` is not `synchronized`: a route that is attached but has no
   * proven parser baseline for its **current** subscription is displaying live
   * output whose history it cannot vouch for. This is the runtime's one answer
   * to "may I call this synchronized", so no consumer has to recompute it from
   * phase plus gap flags:
   *
   * - `unavailable` — no attached stream at all (attaching, reconnecting,
   *   failed, transport-exhausted);
   * - `degraded-live` — attached, but either an observed gap is open or the
   *   current subscription has no verified baseline (screen-only capture,
   *   unproven route cutover, or a route change that revoked the old proof);
   * - `synchronized` — attached **and** the current subscription has a
   *   verified parser baseline with no observed gap.
   */
  streamState: TerminalStreamState;
}

export type TerminalStreamState = 'synchronized' | 'degraded-live' | 'unavailable';

export type SessionRuntimeEvent =
  | { type: 'next-candidate'; activeUrl: string | null }
  | { type: 'force-relay' }
  | { type: 'transport-exhausted'; manualRoute: boolean }
  | { type: 'route-intent-changed'; phase: AttachPhase }
  /** The Agent stated the live Session's authoritative fixed columns (#2487). */
  | { type: 'session-terminal-cols'; cols: number };

/**
 * Value equality for the published snapshot.
 *
 * The store has to be idempotent: subscribers re-render on every notification,
 * and a caller that rebuilds its context on every render would otherwise feed
 * its own re-render back through `updateContext` → `emitSnapshot` — an
 * unbounded loop that any extra render source above the terminal falls into.
 * Republishing a value-equal snapshot is the only thing that makes that
 * feedback possible, so the identity changes only when the content does.
 *
 * Mirrors the fields `buildSnapshot` publishes — the two lists move together.
 * `lastResize` compares by value: callers may hand over an equal but freshly
 * built size.
 */
function isSameSnapshot(a: SessionRuntimeSnapshot, b: SessionRuntimeSnapshot): boolean {
  return a.sessionId === b.sessionId
    && a.phase === b.phase
    && a.transportGeneration === b.transportGeneration
    && a.connectionState === b.connectionState
    && a.agentTerminalApi === b.agentTerminalApi
    && a.activeUrl === b.activeUrl
    && a.forcedRelay === b.forcedRelay
    && a.transportReady === b.transportReady
    && a.lastResize?.cols === b.lastResize?.cols
    && a.lastResize?.rows === b.lastResize?.rows
    && a.reconnectCount === b.reconnectCount
    && a.historyDegraded === b.historyDegraded
    && a.streamState === b.streamState;
}

/**
 * How often the live P2P transport is asked to prove it is still there.
 *
 * Short enough that a user typing into a dead socket finds out in seconds
 * rather than never, long enough not to be the "high-frequency heartbeat"
 * #1213 rules out. Worst-case detection is this plus {@link P2P_PROBE_TIMEOUT_MS}.
 */
const P2P_PROBE_INTERVAL_MS = 15_000;

/**
 * How long a probe may go unanswered before the peer is declared gone.
 *
 * Generous next to a LAN/tunnel round trip (measured ~90 ms in the attach
 * dialog), because a false positive costs a reconnect. The failure this guards
 * against never answers at all, so the deadline does not need to be tight.
 */
const P2P_PROBE_TIMEOUT_MS = 5_000;

/**
 * The identity handshake this socket presents before anything else is served
 * (#1429).
 *
 * The Agent roles and authorizes every attach, control change and input by the
 * connection's `client_id`, and `client.auth` is the only thing that sets it:
 * an unauthenticated connection is `unknown-client`, a principal that is *not*
 * the browser's stable id. The two sides then disagree about who controls the
 * session — the Web compares the control reply against its own id while the
 * Agent compares the caller's — so input is either withheld locally as an
 * observer or refused agent-side. The Server connection has always sent this
 * (`useAppConnection`); this socket did not.
 *
 * Run as the service's handshake, so it is a readiness gate (no frame can be
 * requested before it succeeds) and it repeats on every physical socket, which
 * is what a reconnect needs. The Agent serves it inline after draining the
 * lanes it was read behind, so the frames that follow are served by the
 * identity it establishes.
 *
 * `auth_token` belongs to the Server's half of this handshake and is ignored by
 * the Agent, which shares the one payload type on purpose — and this socket has
 * no Server token to present anyway: its credential was the per-attach one,
 * already proven at the upgrade (#1013). Putting that credential in this field
 * is exactly the conflation the type documents against.
 */
function p2pClientAuthHandshake(surface: HandshakeSurface): Promise<void> {
  return surface
    .request<AuthResponsePayload>(CLIENT_AUTH_WIRE, {
      auth_token: '',
      client_id: getOrCreateClientId(),
    })
    .then((res) => {
      if (res.status !== 'success') {
        throw new Error(res.message || 'P2P client authentication failed');
      }
    });
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly attachState: AttachStateMachine;
  readonly attachController: SessionAttachController;
  private addressPolicy: AddressAttachPolicy;
  /** Live P2P WebSocket service to the current agent candidate (or null in relay). */
  private agentWs: WebSocketService | null = null;
  private agentTerminalApi: TerminalAgentApi | null = null;
  /** Files capability of the live P2P transport — null outside it. */
  private filesApi: FilesPlugin | null = null;
  private routeIntentEpoch: number;
  private transportGeneration = 0;
  private lastResize: { cols: number; rows: number } | null = null;
  /**
   * The size the in-flight attach carried, held from the moment it is sent.
   *
   * Not `lastResize`: that is the *latest* viewport, which may have moved while
   * the attach was in flight — and in that case the newer size is exactly the
   * one the flush must still send. The attach states this pair and the agent
   * applies it, so it is the pair the transport may treat as already known
   * (#1503 follow-up); read once by {@link applyAttachSeedToLiveTransport}.
   */
  private attachedSize: { cols: number; rows: number } | null = null;
  private transportReady = false;
  /** A parser-completed stream position is distinct from attach/stream receipt.
   * Null until an externally verified baseline is explicitly supplied (#1965).
   * No network ACK or recovery claim is generated here. */
  private readonly terminalAppliedCursor = new AppliedTerminalCursor();
  private terminalAppliedBinding: AppliedCursorBinding | null = null;
  /**
   * Runtime-owned dynamic relay fallback: every P2P candidate failed, so the
   * session continues through the server. Deliberately NOT part of the config
   * — it is a verdict the runtime reached, not an intent the caller holds. It
   * is cleared only by a new route intent or a fresh address plan (both arrive
   * via updateContext), never by a steady-state config sync (#1309 SC-02).
   */
  private forcedRelayFallback = false;
  /** Transport generation for which client.attach succeeded. */
  private attachedTransportGeneration: number | null = null;
  /**
   * The transport dropped while this runtime was attached, so the Terminal's
   * buffer may have a hole and must not be trusted as complete.
   *
   * A transport outage alone is NOT proof of missing P2P output: the Agent
   * holds a Session-scoped stream while another subscriber remains (#1619).
   * Replay from the consumer's committed cursor first. A confirmed truncated
   * replay triggers this flag and requests capture-pane on the next attach.
   * Relay (which has no stream cursor) still marks an outage here.
   */
  private historyMayHaveGap = false;
  /**
   * The runtime *observed* output it cannot prove it received: a truncated
   * replay, a hole a replay gave up on, or a lost unsequenced transport.
   *
   * Distinct from {@link historyMayHaveGap}, which also covers "this fresh
   * attach has no buffer yet and wants the history" — a healthy first attach
   * is not a degraded session (#2155). It is cleared only by a complete repair
   * applied to the current renderer, never by a reconnect or attach success.
   */
  private gapDetected = false;
  /**
   * Whether this runtime ever reached `attached` (#2194).
   *
   * A later attach whose mounted renderer parsed no capture is then a
   * **replacement**: the buffer the earlier attach filled is gone, which is an
   * observed loss — not the healthy first attach's "I have nothing yet".
   */
  private everAttached = false;
  /**
   * The last stream epoch this runtime adopted from an attach seed or a relay
   * proof (#2194). A new epoch is a new timeline: the old timeline's ring never
   * held it, so a buffer kept from the previous one cannot be proven
   * continuous with it.
   */
  private lastObservedStreamEpoch: number | null = null;
  /**
   * A requested bootstrap is not a repaired buffer until the *current*
   * xterm has parsed a complete snapshot. Agent attach success does not
   * prove capture succeeded or that the parser applied its bytes (#1645).
   */
  private bootstrapRepairPending = false;
  /**
   * Latest P2P attach cursor from agent.attach — the stream timeline's
   * (#1094) and the input cursor's (#1307).
   *
   * One seed rather than two, because they are stated by one reply and are read
   * at one moment: the effect that consumes this runs on the transition to
   * `attached`, and two getters would let a caller read one without the other
   * and seed a stream cursor against an input cursor from a different attach.
   */
  private p2pAttachSeed: {
    streamEpoch?: number;
    streamCursor?: number;
    preserveAppliedCursor?: boolean;
    subscriberGeneration?: number;
    inputEpoch?: number;
    inputAppliedThrough?: number;
    controlGeneration?: number;
  } | null = null;
  private connectionUnsub: (() => void) | null = null;
  /**
   * The transport most recently handed out by {@link buildTransport}, and the
   * transport generation it was built at. The pair is what lets the runtime
   * apply an attach's cursors to the binding that attach belongs to — and
   * only that binding.
   */
  private liveTransport: TerminalTransport | null = null;
  private liveTransportGeneration = -1;
  private readonly transportSwapListeners = new Set<() => void>();
  /** Liveness probe for the live P2P transport — see `startLivenessProbe`. */
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Invalidates in-flight probes. Bumped whenever the probe is disarmed, so a
   * pong deadline that expires *after* the transport already moved on cannot
   * declare a dead socket the recovery is in the middle of replacing.
   */
  private livenessProbeToken = 0;
  /** One outstanding input-triggered probe — see `probeLivenessNow`. */
  private livenessProbeInFlight = false;
  private readonly connectionStateListeners = new Set<(state: ConnectionState) => void>();
  private readonly runtimeEventListeners = new Set<(event: SessionRuntimeEvent) => void>();
  private readonly attachOutcomeListeners = new Set<(result: AttachTransitionResult) => void>();
  /** Guards against re-entrant / duplicate terminal-disconnect handling. */
  private disconnectHandling = false;
  private relayServerUnsub: (() => void) | null = null;
  private relayReadyUnsub: (() => void) | null = null;
  /** Exact begin envelope, scoped to its physical Server socket. */
  private relayBeginWire: SentSocketMessage | null = null;
  /** Informational only: no verified renderer baseline or ACK credit. */
  private relayProof: RelaySubscriptionProof | null = null;
  private disposed = false;
  private snapshot: SessionRuntimeSnapshot;
  private readonly snapshotListeners = new Set<() => void>();

  constructor(private config: SessionRuntimeConfig) {
    this.sessionId = config.sessionId;
    this.routeIntentEpoch = config.routeIntentEpoch;
    // Every UI uses the same transport-first attach protocol: the state
    // machine gates attach on the terminal viewport being transport-ready.
    this.attachState = new AttachStateMachine({ transportFirst: true });
    this.attachController = new SessionAttachController(this.attachState);
    this.addressPolicy = new AddressAttachPolicy({
      attachInfo: config.attachInfo,
      orderedUrls: config.orderedUrls,
      manualOverride: config.manualOverride,
      forcedRelay: config.forcedRelay,
      addressUrls: config.addressUrls,
      addressIndex: 0,
    });
    // transportReady and lastResize are NOT config: they are facts about the
    // live xterm viewport, pushed by its adapter (setTransportReady /
    // updateViewportSize). Carrying them in the config let a stale React-side
    // value clobber the fresher push on every updateContext (#1309 SC-02).
    this.snapshot = this.buildSnapshot();
    this.attachController.subscribeOutcomes((result) => {
      if (result.phase === 'attached') {
        this.everAttached = true;
        this.attachedTransportGeneration = this.transportGeneration;
        // Attach confirms the PTY subscription, not the xterm buffer.
        // Only noteBootstrapApplied() may clear a pending history repair.
        this.applyAttachSeedToLiveTransport();
        // An atomic bootstrap can be parsed before this reply installs the
        // subscriber generation; now that the identity exists, offer the
        // already-proven parser frontier as the first output ACK.
        this.submitPendingAppliedAck();
      }
      if (result.forceRelay) {
        this.applyForceRelay();
      } else if (result.retryAttach) {
        // Self-driving retry: an attach timeout with budget remaining must
        // schedule the next client.attach without any React/Jotai tick.
        this.maybeStartP2PAttach();
      } else if (result.phase === 'connecting' || result.phase === 'reconnecting') {
        // A relay attach opportunity appeared (SESSION_SELECTED, relay loss,
        // failed recovery). Deferred a tick: this listener runs inside the
        // controller's outcome emission, and RELAY_BEGIN_OK would otherwise be
        // delivered to React mirrors before the outcome being processed here.
        this.requestRelayAttach();
      }
      for (const listener of this.attachOutcomeListeners) {
        listener(result);
      }
      this.emitSnapshot();
    });
    // The runtime exists because a session was selected — attach begins here,
    // not in a React effect that notices the runtime (#1309 SC-01). A runtime
    // that outlives its React tree (registry lease) never re-selects:
    // selection is a construction fact; later route intents arrive via
    // updateContext.
    this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    this.syncAgentConnection();
    this.wireRelayServerHandler();
    this.driveRelayAttach();
    this.snapshot = this.buildSnapshot();
  }

  getMirrorSnapshot(): RuntimeMirrorSnapshot {
    return {
      phase: this.attachState.phase,
      transportGeneration: this.transportGeneration,
      connectionState: this.agentWs?.connectionState ?? 'disconnected',
      agentTerminalApi: this.effectiveForcedRelay ? null : this.agentTerminalApi,
    };
  }

  /** Cached external-store snapshot consumed by either terminal UI. */
  getSnapshot = (): SessionRuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  setTransportReady(ready: boolean): void {
    if (this.transportReady === ready) {
      return;
    }
    this.transportReady = ready;
    if (!ready) {
      // Replacing a transport can replace its xterm binding; retained stream
      // receipt is never proof that the *new* renderer parsed those bytes.
      this.resetTerminalAppliedCursor();
    }
    if (ready) {
      if (this.effectiveForcedRelay && this.attachState.phase === 'idle') {
        this.attachController.dispatch({ type: 'SESSION_SELECTED' });
      }
      this.maybeStartP2PAttach();
      this.driveRelayAttach();
    }
    this.emitSnapshot();
  }

  updateViewportSize(size: { cols: number; rows: number }): void {
    if (this.lastResize?.cols === size.cols && this.lastResize?.rows === size.rows) {
      return;
    }
    this.lastResize = size;
    this.emitSnapshot();
  }

  /**
   * The effective relay mode: static config intent OR the runtime's own
   * fallback. Every behavioral read of "are we relay" goes through here —
   * reading `config.forcedRelay` directly would miss the fallback, and the
   * fallback is what keeps a session alive after its candidates fail.
   */
  private get effectiveForcedRelay(): boolean {
    return this.config.forcedRelay || this.forcedRelayFallback;
  }

  subscribeAttachOutcomes(handler: (result: AttachTransitionResult) => void): () => void {
    this.attachOutcomeListeners.add(handler);
    return () => {
      this.attachOutcomeListeners.delete(handler);
    };
  }

  get activeUrl(): string | null {
    return this.addressPolicy.activeUrl;
  }

  /** Bumps on internal candidate rotation; distinct from routeIntentEpoch. */
  get currentTransportGeneration(): number {
    return this.transportGeneration;
  }

  get currentRouteIntentEpoch(): number {
    return this.routeIntentEpoch;
  }

  getAgentTerminalApi(): TerminalAgentApi | null {
    return this.agentTerminalApi;
  }

  getP2pAttachSeed(): {
    streamEpoch?: number;
    streamCursor?: number;
    subscriberGeneration?: number;
    inputEpoch?: number;
    inputAppliedThrough?: number;
    controlGeneration?: number;
  } | null {
    return this.p2pAttachSeed;
  }

  /** Live agent-transport connection state ('disconnected' outside the P2P transport). */
  get connectionState(): ConnectionState {
    return this.agentWs?.connectionState ?? 'disconnected';
  }

  getFilesApi(): FilesPlugin | null {
    return this.filesApi;
  }

  /**
   * The client's half of the bootstrap handshake (#321): whether an attach made
   * now should ask the agent for the session's history.
   *
   * Read at each attach rather than cached, because the answer changes exactly
   * when output first arrives and this runtime may have been built before or
   * after that — see {@link SessionRuntimeConfig.hasSessionOutput}.
   *
   * **Two questions, and only one of them was being asked.**
   * `hasSessionOutput` answers "does my Terminal hold anything". A client whose
   * transport dropped mid-session holds plenty — it holds a buffer with a hole
   * in it — so it answered *yes* and skipped the snapshot, which is how a
   * recovered session kept the gap (#1233).
   *
   * {@link historyMayHaveGap} is the second question: "can my buffer be trusted
   * to be complete". A bootstrap is the right repair for it and not merely a
   * convenient one — it **replaces** the buffer from tmux's own scrollback,
   * which tmux retains regardless of who is attached, so refilling a hole
   * cannot duplicate what the client already has.
   *
   * **The third question is who holds the buffer now** (#2194).
   * A replacement renderer receives live frames as soon as a transport is
   * bound, so `hasSessionOutput` answers *yes* for a terminal that holds no
   * history at all — and the attach then skips the capture. `hasSessionHistory`
   * asks the narrower question: did a capture parse into the renderer that is
   * mounted now. Absent readers keep the pre-#2194 answer.
   */
  private needsBootstrap(): boolean {
    return this.historyMayHaveGap
      || !(this.config.hasSessionOutput?.() ?? false)
      || !(this.config.hasSessionHistory?.() ?? true);
  }

  /**
   * Capture the bootstrap decision *before* sending attach. Even on the
   * first attach, session output can arrive while capture fails; a live
   * frame must not make the next attach assume history is complete.
   */
  private requestBootstrapForAttach(): boolean {
    const needed = this.needsBootstrap();
    if (needed) {
      this.historyMayHaveGap = true;
      this.bootstrapRepairPending = true;
      // A re-attach onto a renderer that parsed no capture is a replacement:
      // whatever the previous attach filled is gone. That is an observed loss,
      // and the degraded statement must survive until a capture proves it
      // repaired — a transport swap alone must not present a fresh buffer as
      // continuous (#2194).
      if (this.everAttached && !(this.config.hasSessionHistory?.() ?? true)) {
        this.gapDetected = true;
        this.emitSnapshot();
      }
    }
    return needed;
  }

  /**
   * Called only after a non-truncated bootstrap's xterm write callback,
   * and only from the currently bound Terminal transport. A successful
   * attach response alone is insufficient (#1645).
   */
  /**
   * Only a source that actually proves its checkpoint/empty-renderer cut may
   * call this. Not agent.attach cursor, not a plain tmux capture, not an
   * onBootstrapApplied boolean. A failed rebind invalidates the old cursor.
   */
  setVerifiedTerminalBaseline(baseline: VerifiedTerminalBaseline): void {
    this.terminalAppliedBinding = null;
    this.terminalAppliedCursor.reset();
    if (this.disposed) { return; }
    this.terminalAppliedBinding = this.terminalAppliedCursor.beginFromVerifiedBaseline(baseline);
    // The capture names the timeline this renderer is now proven against.
    // The attach reply and the Relay proof arrive *after* the history they
    // describe, so adopting their (same) epoch must not count as a change —
    // treating it as one re-degraded a terminal the capture had just repaired
    // (#2194). A genuinely different epoch still differs from this value.
    this.lastObservedStreamEpoch = baseline.streamEpoch;
    // The bootstrap that proves this cut is delivered *before* the attach
    // reply that states the subscriber generation (and before a Relay ready
    // proof), so the identity may not exist yet. Try now for the orderings
    // where it does; the attach/proof owners retry when it lands.
    this.submitPendingAppliedAck();
    // `streamState` is derived from this proof: an attached stream that was
    // degraded-live becomes synchronized at this exact moment, and subscribers
    // must be told (the value-equality filter drops a no-op).
    this.emitSnapshot();
  }

  /** Current renderer's parser-applied *proof*, never transport receipt. */
  get terminalAppliedSnapshot(): AppliedCursorSnapshot | null {
    const binding = this.terminalAppliedBinding;
    return binding ? this.terminalAppliedCursor.snapshot(binding) : null;
  }

  /** TerminalController only emits this after its xterm callback / FIFO resize. */
  noteStreamEventParsed(position: TerminalStreamPosition): void {
    const binding = this.terminalAppliedBinding;
    if (this.disposed || !binding) { return; }
    if (this.terminalAppliedCursor.recordParsed(binding, position) !== 'advanced') {
      return;
    }
    this.submitPendingAppliedAck();
  }

  /**
   * Offer the current parser-applied frontier as an output ACK, if this
   * runtime holds the current route/subscriber/renderer proof for it.
   *
   * Only parser-completed, contiguous events in a verified renderer
   * generation may advance Agent credit. A relay receipt/stream delivery,
   * screen-only capture or duplicate callback cannot cross this gate. Sending
   * does not prove the Agent accepted or credited it — `recordAckSubmitted`
   * records only a frame the transport accepted.
   */
  private submitPendingAppliedAck(): void {
    const binding = this.terminalAppliedBinding;
    if (this.disposed || !binding) { return; }
    const snapshot = this.terminalAppliedCursor.snapshot(binding);
    if (!snapshot) {
      this.terminalAppliedBinding = null;
      return;
    }
    if (snapshot.appliedSeq <= snapshot.ackSentSeq
      || this.attachState.phase !== 'attached'
      || this.liveTransportGeneration !== this.transportGeneration) {
      return;
    }

    if (this.effectiveForcedRelay) {
      this.sendVerifiedRelayOutputAck(binding, snapshot);
      return;
    }

    const seed = this.p2pAttachSeed;
    const api = this.agentTerminalApi;
    const subscriberGeneration = seed?.subscriberGeneration;
    if (this.attachedTransportGeneration !== this.transportGeneration
      || !api?.sendOutputApplied
      || !Number.isSafeInteger(subscriberGeneration) || !subscriberGeneration
      || !seed?.streamEpoch || seed.streamEpoch !== snapshot.streamEpoch) {
      return;
    }
    if (api.sendOutputApplied(this.config.sessionName, {
      subscriberGeneration,
      streamEpoch: snapshot.streamEpoch,
      rendererGeneration: snapshot.generation,
      appliedThrough: snapshot.appliedSeq,
    })) {
      this.terminalAppliedCursor.recordAckSubmitted(binding, snapshot.appliedSeq);
    }
  }

  /** Separate current-route proof admission from parser prefix accounting.
   * A Server receipt alone is never a parser baseline or issued-byte credit.
   */
  private sendVerifiedRelayOutputAck(
    binding: AppliedCursorBinding,
    snapshot: AppliedCursorSnapshot,
  ): void {
    const conn = this.config.serverConnection;
    const proof = this.relayProof;
    const sent = this.relayBeginWire;
    if (!conn?.isReady() || !conn.sendRelayOutputApplied || !proof || !sent
      || proof.streamEpoch !== snapshot.streamEpoch
      || proof.sessionName !== this.config.sessionName
      || proof.browserClientId !== getOrCreateClientId()) {
      return; // unverified/legacy/stale routes have no credit
    }
    // The proof was accepted only on the exact begin+physical socket. Agent
    // rechecks peer token, stream generation/epoch and the issued frontier.
    if (conn.sendRelayOutputApplied(this.config.sessionName, {
      subscriberGeneration: proof.subscriberGeneration,
      streamEpoch: snapshot.streamEpoch,
      rendererGeneration: snapshot.generation,
      appliedThrough: snapshot.appliedSeq,
    })) {
      this.terminalAppliedCursor.recordAckSubmitted(binding, snapshot.appliedSeq);
    }
  }

  private resetTerminalAppliedCursor(): void {
    this.terminalAppliedBinding = null;
    this.terminalAppliedCursor.reset();
  }

  noteBootstrapApplied(): void {
    if (!this.bootstrapRepairPending) {
      return;
    }
    this.bootstrapRepairPending = false;
    this.historyMayHaveGap = false;
    // The repair was applied to the current renderer; the observed gap it was
    // repairing is closed. A later loss sets it again on its own.
    this.gapDetected = false;
    this.emitSnapshot();
  }

  /**
   * The stream reported that replay cannot reach back to this client's cursor
   * (#1304): the agent's retained window has passed it, or a hole was given up
   * on and the frames in hand committed over it. Either way the buffer this
   * Terminal holds has a hole in it that no later replay can fill.
   *
   * It is the same fact a lost transport leaves behind — "my buffer may not be
   * complete" — and it takes the same repair, which is why it sets the same
   * flag rather than a new one: a bootstrap **replaces** the buffer from tmux's
   * own scrollback, so refilling a hole cannot duplicate what the client
   * already has.
   *
   * The repair rides the next attach, deliberately. A snapshot cannot be asked
   * for on a live transport — `client.attach` carries the request and
   * `canStartAttach` refuses one while the phase is `attached` — so the choice
   * here is between remembering and tearing down a healthy transport to force
   * one. Remembering loses nothing that was still reachable: the events the
   * hole is missing are already unrecoverable, and everything the buffer holds
   * is still on screen.
   */
  noteStreamTruncated(): void {
    this.resetTerminalAppliedCursor();
    this.historyMayHaveGap = true;
    // This is the one place the runtime *observed* a hole. The bootstrap need
    // and the degraded notice share the trigger but not the lifetime: the
    // first attach also requests a bootstrap, yet nothing was lost (#2155).
    this.gapDetected = true;
    // A newly discovered hole invalidates a repair that was in flight
    // before the loss was reported, even if its parser callback is late.
    this.bootstrapRepairPending = false;
    this.emitSnapshot();
  }

  /**
   * Adopt a stream epoch from an attach seed or a relay proof, stating the gap
   * when it changed (#2194).
   *
   * A different epoch means the process that owned the old timeline is gone.
   * The client may have kept the old buffer; nothing it holds can be proven
   * continuous with the new timeline, and the new Agent's ring never held the
   * events before it. Stating the gap is what makes the loss visible and makes
   * the next attach request the capture that repairs it, instead of seeding
   * the new epoch over the old buffer as if it continued.
   */
  private adoptStreamEpoch(epoch: number | undefined): void {
    if (epoch === undefined || !Number.isSafeInteger(epoch) || epoch <= 0) {
      return;
    }
    const previous = this.lastObservedStreamEpoch;
    this.lastObservedStreamEpoch = epoch;
    if (previous !== null && previous !== epoch) {
      this.noteStreamEpochChanged();
    }
  }

  /**
   * The epoch-change half of {@link noteStreamTruncated}.
   *
   * It deliberately keeps a requested bootstrap pending: unlike an observed
   * replay hole, the capture in flight may be exactly the new epoch's proven
   * cut, and `noteBootstrapApplied` is the one thing allowed to clear the gap.
   */
  private noteStreamEpochChanged(): void {
    this.resetTerminalAppliedCursor();
    this.historyMayHaveGap = true;
    this.gapDetected = true;
    this.emitSnapshot();
  }

  /**
   * The renderer was replaced because its parser writer halted (#2196).
   *
   * A halted writer drops operations and cannot vouch for the parser state
   * afterwards, so the replacement starts empty — the session's history is
   * gone with the old buffer. The only repair is a bootstrap parsed by the
   * replacement, and a bootstrap cannot be requested on a live attach
   * (`canStartAttach` refuses while attached), so this retires the current
   * transport and drives a fresh attach that asks for one.
   *
   * Unlike an observed replay hole, the repair here is being requested right
   * now: `bootstrapRepairPending` stays true so `noteBootstrapApplied` is the
   * only thing that clears the degraded state. A capture that reaches the new
   * renderer but does not prove its cut leaves the gap stated.
   */
  noteRendererReplaced(): void {
    if (this.disposed) { return; }
    this.resetTerminalAppliedCursor();
    this.historyMayHaveGap = true;
    this.gapDetected = true;
    this.bootstrapRepairPending = true;
    this.emitSnapshot();
    this.forceBootstrapReattach();
  }

  /**
   * Retire the current transport and start a fresh attach that carries
   * `needs_bootstrap` (#2196).
   *
   * Shaped like a route-intent change because it needs the same guarantees:
   * the old generation is fenced off before it is torn down, so no late frame
   * from the disposed transport can write into the replacement renderer, and
   * the new attach is driven by the runtime rather than by a React tick.
   */
  private forceBootstrapReattach(): void {
    const hadP2PBinding = this.agentWs !== null || this.agentTerminalApi !== null;
    this.revokeRelayProof();
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.attachController.dispatch({ type: 'DISCONNECT' });
    const result = this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    this.transportGeneration += 1;
    this.syncAgentConnection({ forceReconnect: true });
    if (this.effectiveForcedRelay) {
      // The relay branch has no P2P binding to retire, so syncAgentConnection
      // does not announce a swap; the controller's replacement renderer still
      // needs a transport built for the advanced generation, and the relay
      // attach has to be driven from here.
      if (!hadP2PBinding) {
        this.emitTransportSwap();
      }
      this.requestRelayAttach();
    }
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
    this.emitSnapshot();
  }

  updateContext(next: Partial<SessionRuntimeConfig>): RuntimeMirrorSnapshot {
    const previousServerConnection = this.config.serverConnection;
    const previousRelay = this.effectiveForcedRelay;
    const routeChanged =
      next.routeIntentEpoch !== undefined
      && next.routeIntentEpoch !== this.routeIntentEpoch;
    const planUrlsChanged =
      next.addressUrls !== undefined
      && next.addressUrls.join('|') !== this.config.addressUrls.join('|');
    this.config = { ...this.config, ...next };
    if (previousServerConnection !== this.config.serverConnection
      || routeChanged || planUrlsChanged || previousRelay !== this.effectiveForcedRelay) {
      this.revokeRelayProof();
    }
    if (next.routeIntentEpoch !== undefined) {
      this.routeIntentEpoch = next.routeIntentEpoch;
    }
    if (routeChanged || planUrlsChanged) {
      // The fallback was a verdict about the old route's candidates; a new
      // route intent or a fresh address plan retries P2P (#1309 SC-02). A
      // steady-state config sync touches neither and must NOT clear it — that
      // round trip is what used to clobber the fallback.
      this.forcedRelayFallback = false;
    }

    // A route-mode flip retires the current transport even when the previous
    // candidate never opened a WebSocket. The generation must advance before
    // any teardown/relay attach notifies subscribers; relying only on
    // syncAgentConnection's hadBinding check leaves stale callbacks live.
    // Explicit route-intent changes already advance in handleRouteIntentChange.
    if (!routeChanged && previousRelay !== this.effectiveForcedRelay) {
      this.transportGeneration += 1;
      this.attachedTransportGeneration = null;
      this.resetTerminalAppliedCursor();
    }

    this.addressPolicy.update({
      attachInfo: this.config.attachInfo,
      orderedUrls: this.config.orderedUrls,
      manualOverride: this.config.manualOverride,
      forcedRelay: this.effectiveForcedRelay,
      addressUrls: this.config.addressUrls,
      addressIndex: this.addressPolicy.currentIndex,
    });

    if (routeChanged) {
      this.addressPolicy.resetIndex();
      this.handleRouteIntentChange();
      this.emitSnapshot();
      return this.getMirrorSnapshot();
    }

    this.syncAgentConnection();
    this.wireRelayServerHandler();
    // A relay attach may be due now: forced-relay context just applied, or the
    // xterm viewport became ready while relay attach was pending.
    this.driveRelayAttach();
    this.emitSnapshot();
    return this.getMirrorSnapshot();
  }

  private applyForceRelay(): void {
    if (this.effectiveForcedRelay) {
      return;
    }
    this.revokeRelayProof();
    this.forcedRelayFallback = true;
    // A P2P → Relay fallback cuts the route: the Relay subscription cannot
    // prove continuity with the frames the P2P transport delivered, so a
    // buffer that holds output may have a hole only a capture can prove
    // closed. State that and request the capture. Gated on the renderer
    // holding output at all — a first attach whose terminal is still empty
    // loses nothing, and its normal bootstrap request carries no degradation
    // (#2155). Deliberately not gated on this runtime having attached: the
    // fallback can land on a runtime created after the loss, and the question
    // is about the renderer, not this object's history.
    if (this.config.hasSessionOutput?.() ?? false) {
      this.historyMayHaveGap = true;
      this.bootstrapRepairPending = true;
      this.gapDetected = true;
    }
    this.addressPolicy.update({ forcedRelay: true });
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.transportGeneration += 1;
    this.syncAgentConnection();
    this.wireRelayServerHandler();
    this.emitRuntimeEvent({ type: 'force-relay' });
    // The P2P → relay transport flip is complete; relay attach follows in the
    // same tick unless the server WS is not authenticated yet.
    this.requestRelayAttach();
    this.emitSnapshot();
  }

  private handleRouteIntentChange(): void {
    this.revokeRelayProof();
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.attachController.dispatch({ type: 'DISCONNECT' });
    const result = this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    this.transportGeneration += 1;
    this.syncAgentConnection({ forceReconnect: true });
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
  }

  private maybeStartP2PAttach(): void {
    if (this.effectiveForcedRelay || !this.agentWs || !this.agentTerminalApi) {
      return;
    }
    if (this.agentWs.connectionState !== 'connected') {
      return;
    }
    const phase = this.attachState.phase;
    if (phase === 'attached' && this.attachedTransportGeneration === this.transportGeneration) {
      return;
    }
    if (phase === 'idle' || phase === 'failed') {
      return;
    }
    if (!this.attachController.canStartAttach(this.transportReady, true, false, 'p2p')) {
      return;
    }
    // Held for the attach's own lifetime: this is what the payload states, and
    // `lastResize` may move past it before the reply lands.
    const attachSize = this.lastResize;
    // If this client retained its Terminal buffer, the attach is a stream
    // continuation, not a fresh snapshot. The old *applied* cursor, rather
    // than the Agent's latest cursor, is the safe replay position (#1213).
    const needsBootstrap = this.requestBootstrapForAttach();
    const preserveAppliedCursor = !needsBootstrap
      && this.p2pAttachSeed?.streamEpoch !== undefined;
    this.attachController.startP2PAttach({
      sessionName: this.config.sessionName,
      agentApi: this.agentTerminalApi,
      manualRoute: this.config.manualOverride !== null,
      lastResize: attachSize,
      needsBootstrap,
      transportGeneration: this.transportGeneration,
      onAttachOk: (result) => {
        // An attach reply names the stream epoch this subscription continues.
        // If it differs from the last one adopted, the buffer kept across the
        // loss belongs to a timeline this Agent cannot replay (#2194).
        this.adoptStreamEpoch(result.streamEpoch);
        if (result.terminalCols !== undefined) {
          this.emitRuntimeEvent({ type: 'session-terminal-cols', cols: result.terminalCols });
        }
        this.attachedSize = attachSize;
        this.p2pAttachSeed = {
          streamEpoch: result.streamEpoch,
          streamCursor: result.streamCursor,
          subscriberGeneration: result.subscriberGeneration,
          preserveAppliedCursor,
          inputEpoch: result.inputEpoch,
          inputAppliedThrough: result.inputAppliedThrough,
          controlGeneration: result.controlGeneration,
        };
      },
    });
  }

  /**
   * Synchronously apply the address policy when the current P2P candidate
   * transport drops: advance to the next candidate, force relay, or exhaust.
   * The connection-loss handler routes through this under the re-entrancy
   * guard; kept public so tests can drive the policy step synchronously.
   */
  onCandidateDisconnected(): 'next-candidate' | 'force-relay' | 'transport-exhausted' | 'none' {
    return this.applyCandidateDisconnect();
  }

  /**
   * Build the session's I/O transport from the facts this runtime owns right
   * now: the mode, the live agent API of the current transport generation,
   * the relay handle, the attach gate, and the runtime's own callbacks.
   *
   * The transport is tagged with the generation it was built at, which is
   * what makes the #1309 transport-binding invariant structural rather than
   * procedural: a transport built for generation N carries generation N's
   * agent API because both were read from the same object in the same call,
   * and the swap notification that triggers a rebuild is emitted only AFTER
   * the new identity is installed — never before (#668's race, closed by
   * construction instead of by React effect ordering).
   */
  buildTransport(): TerminalTransport {
    const relay = this.effectiveForcedRelay;
    const owningGeneration = this.transportGeneration;
    const transport = this.config.createTransport({
      mode: relay ? 'relay' : 'p2p',
      sessionName: this.config.sessionName,
      sessionId: this.sessionId,
      agentApi: relay ? undefined : this.agentTerminalApi ?? undefined,
      serverConnection: relay ? this.config.serverConnection ?? undefined : undefined,
      isAttached: () => this.attachState.phase === 'attached',
      isCurrentGeneration: () => !this.disposed && owningGeneration === this.transportGeneration,
      // Input is the moment a dead-but-open socket stops being invisible
      // (#1264); a stream with a hole is a fact for the owner (#1304); input
      // that can never arrive is reported, not kept (#1307 SC-09).
      onInputSent: () => this.probeLivenessNow(),
      onStreamTruncated: () => this.noteStreamTruncated(),
      onInputDrop: (drop) => this.config.onInputDrop?.(drop),
    });
    this.liveTransport = transport;
    this.liveTransportGeneration = this.transportGeneration;
    return transport;
  }

  /**
   * Posted synchronously when the runtime has finished swapping the live
   * transport identity (candidate rotation, route switch, P2P↔relay flip) —
   * after the new identity is installed, so a listener that rebuilds its
   * binding inside the callback binds the new generation, never the old one.
   */
  subscribeTransportSwap(listener: () => void): () => void {
    this.transportSwapListeners.add(listener);
    return () => this.transportSwapListeners.delete(listener);
  }

  private emitTransportSwap(): void {
    this.resetTerminalAppliedCursor();
    for (const listener of this.transportSwapListeners) {
      listener();
    }
  }

  /**
   * Apply what a successful attach stated about the session's cursors, then
   * let buffered I/O out (#1094, #1307).
   *
   * This used to be a React effect on the 'attached' phase, but the runtime
   * owns both halves of the handoff — the seed (stated by the attach reply)
   * and the transport it applies to (built here, tagged with the generation
   * it binds) — so the effect was a courier between two things one owner
   * already holds. The order is load-bearing and unchanged: the input cursor
   * is reconciled BEFORE the flush (the flush is numbered against it), the
   * stream cursor is seeded AFTER it (it fills a timeline the reconciler
   * owns).
   */
  private applyAttachSeedToLiveTransport(): void {
    const transport = this.liveTransport;
    if (!transport || this.liveTransportGeneration !== this.attachedTransportGeneration) {
      return;
    }
    const seed = this.p2pAttachSeed;
    if (seed) {
      transport.seedInputCursor?.({
        inputEpoch: seed.inputEpoch,
        appliedThrough: seed.inputAppliedThrough,
        controlGeneration: seed.controlGeneration,
      });
    }
    // Before the flush, so a coalesced size that only repeats what the attach
    // already stated does not go back out as a change (#1503 follow-up).
    const attached = this.attachedSize;
    this.attachedSize = null;
    if (attached) {
      transport.noteAttachedSize?.(attached.cols, attached.rows);
    }
    transport.flushAllOutbound();
    if (seed) {
      transport.seedStreamCursor?.(seed.streamEpoch, seed.streamCursor, {
        preserveAppliedCursor: seed.preserveAppliedCursor,
      });
    }
  }

  subscribeConnectionState(handler: (state: ConnectionState) => void): () => void {
    this.connectionStateListeners.add(handler);
    return () => {
      this.connectionStateListeners.delete(handler);
    };
  }

  subscribeRuntimeEvents(handler: (event: SessionRuntimeEvent) => void): () => void {
    this.runtimeEventListeners.add(handler);
    return () => {
      this.runtimeEventListeners.delete(handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.revokeRelayProof();
    this.resetTerminalAppliedCursor();
    // End the server-side relay forwarding loop with the runtime that began
    // it (#1309 SC-08). Disposal covers every leave — disconnect, session
    // switch, unmount — so this is the one place an endRelay can never be
    // forgotten; the orchestration's dead controller.onDisconnect chain used
    // to pretend to cover exactly one of them. Best-effort: a gone server
    // connection has nothing to tell, and dispose must not throw.
    if (this.effectiveForcedRelay && this.config.attachInfo && this.config.serverConnection?.isReady()) {
      try {
        this.config.serverConnection.endRelay(this.sessionId);
      } catch { /* best-effort teardown */ }
    }
    this.teardownConnectionHandler();
    this.teardownRelayServerHandler();
    this.attachController.cancelActiveAttach();
    this.agentWs?.dispose();
    this.agentWs = null;
    this.agentTerminalApi = null;
    this.filesApi = null;
    this.liveTransport = null;
    this.connectionStateListeners.clear();
    this.runtimeEventListeners.clear();
    this.snapshotListeners.clear();
    this.transportSwapListeners.clear();
  }

  private emitConnectionState(state: ConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      listener(state);
    }
    this.emitSnapshot();
  }

  private emitRuntimeEvent(event: SessionRuntimeEvent): void {
    for (const listener of this.runtimeEventListeners) {
      listener(event);
    }
  }

  private buildSnapshot(): SessionRuntimeSnapshot {
    return {
      ...this.getMirrorSnapshot(),
      sessionId: this.sessionId,
      activeUrl: this.activeUrl,
      forcedRelay: this.effectiveForcedRelay,
      transportReady: this.transportReady,
      lastResize: this.lastResize,
      reconnectCount: this.attachState.reconnectCount,
      historyDegraded: this.gapDetected,
      streamState: this.computeStreamState(),
    };
  }

  /**
   * The one derivation of {@link SessionRuntimeSnapshot.streamState}.
   *
   * A verified baseline is bound to the *current* subscription and renderer
   * generation; `terminalAppliedSnapshot` is null until one exists and is
   * revoked by a route change or an observed gap. Phase alone cannot answer
   * this: an attached stream with a screen-only capture is live output whose
   * history is unproven, and claiming it synchronized would be exactly the
   * false claim #1645 forbids.
   */
  private computeStreamState(): TerminalStreamState {
    if (this.attachState.phase !== 'attached') {
      return 'unavailable';
    }
    return this.gapDetected || this.terminalAppliedSnapshot === null
      ? 'degraded-live'
      : 'synchronized';
  }

  private emitSnapshot(): void {
    if (this.disposed) {
      return;
    }
    const next = this.buildSnapshot();
    if (this.snapshot && isSameSnapshot(this.snapshot, next)) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.snapshotListeners) {
      listener();
    }
  }

  private applyCandidateDisconnect(): 'next-candidate' | 'force-relay' | 'transport-exhausted' | 'none' {
    const action = this.addressPolicy.onCandidateDisconnected();
    if (action.type === 'next-candidate') {
      this.attachedTransportGeneration = null;
      this.transportGeneration += 1;
      this.syncAgentConnection();
      this.emitRuntimeEvent({ type: 'next-candidate', activeUrl: this.activeUrl });
      this.emitSnapshot();
      return 'next-candidate';
    }
    if (action.type === 'force-relay') {
      // Same atomic transition as attach-error fallback — policy flip, P2P
      // teardown, and relay attach all happen inside applyForceRelay.
      this.applyForceRelay();
      return 'force-relay';
    }
    if (action.type === 'transport-exhausted') {
      this.attachController.dispatch({
        type: 'TRANSPORT_EXHAUSTED',
        manualRoute: action.manualRoute,
      });
      this.emitRuntimeEvent({
        type: 'transport-exhausted',
        manualRoute: action.manualRoute,
      });
      this.emitSnapshot();
      return 'transport-exhausted';
    }
    return 'none';
  }

  private handleTerminalDisconnect(): void {
    if (this.disconnectHandling) {
      return;
    }
    this.disconnectHandling = true;
    try {
      this.onCandidateDisconnected();
    } finally {
      this.disconnectHandling = false;
    }
  }

  private teardownConnectionHandler(): void {
    this.connectionUnsub?.();
    this.connectionUnsub = null;
    // Every path that drops the connection handler also ends the probe, and
    // `wireConnectionHandler` re-arms it on the next `'connected'`. Kept here
    // rather than in `dispose()` because the other three callers are the ones
    // that rebuild the transport — a probe left armed across a rebuild would
    // be questioning a socket that no longer exists.
    this.stopLivenessProbe();
  }

  /**
   * Ask the agent to prove it is still there, for as long as the P2P transport
   * *claims* to be connected.
   *
   * **This is the only client-side thing that can notice a half-open socket**,
   * and the reason the claim is the right trigger: when a peer goes silent the
   * browser fires no `close`, so `WebSocketService`'s loss path — wired to
   * `onclose` — never runs. `connectionState` stays `'connected'`, the attach
   * gate stays open, and `sendRaw`'s guard checks only `readyState`, which is
   * still 1. Keystrokes are written into the void with no error, no reconnect
   * and nothing on screen — the terminal stays interactive-looking while both
   * directions are dead (#1233).
   *
   * A missed pong is that missing signal. The agent already replies
   * (`make_response(&self.id, CONTROL_PONG, ())`), so the probe only has to
   * wait — and the failure is handed to `reportUnresponsive()`, which routes it
   * through the ordinary loss path so the reconnect budget, candidate rotation
   * and force-relay all apply unchanged.
   */
  private startLivenessProbe(): void {
    this.stopLivenessProbe();
    const api = this.agentTerminalApi;
    if (!api) {
      return;
    }
    const token = this.livenessProbeToken;
    this.livenessTimer = setInterval(() => {
      this.runLivenessProbe(token);
    }, P2P_PROBE_INTERVAL_MS);
  }

  /**
   * Question the link now instead of waiting for the next tick (#1264).
   *
   * Called when the user sends input, which is the moment the cost of a dead
   * socket stops being invisible: a half-open transport still reports
   * `attached`, so `ConnectionManager` keeps handing keystrokes to it and they
   * are dropped. Detection is what turns that around — once the loss is
   * reported, the ordinary path buffers input instead of dropping it.
   *
   * Same timeout as the timer, deliberately. A link slower than
   * `P2P_PROBE_TIMEOUT_MS` already trips the interval probe today, so firing
   * the same check earlier adds no failure class; shortening the deadline would
   * be the version that starts tearing down live-but-slow links, which is a
   * much worse trade than a slightly wider detection window.
   */
  /** Foreground is a hint to advance the existing recovery path (#1213). */
  resumeOnForeground(): void {
    const transport = this.agentWs;
    if (!transport) { return; }
    if (transport.connectionState === 'connected') {
      this.probeLivenessNow();
    } else {
      // connect() shares an in-flight attempt; reconnectNow() cancels only
      // stale backoff, so duplicate pageshow/visibility events are harmless.
      void transport.reconnectNow().catch(() => {});
    }
  }

  probeLivenessNow(): void {
    if (this.attachState.phase !== 'attached') {
      return;
    }
    // At most one outstanding probe. Typing is continuous and a probe per
    // keystroke would both flood the request layer and stack deadlines on the
    // same socket — the question is "is the link alive", and one answer at a
    // time settles it.
    if (this.livenessProbeInFlight) {
      return;
    }
    this.livenessProbeInFlight = true;
    this.runLivenessProbe(this.livenessProbeToken, () => {
      this.livenessProbeInFlight = false;
    });
  }

  private runLivenessProbe(token: number, onSettled?: () => void): void {
    // Only the **attached** state has the hole this fills. An unattached
    // transport is already driven by the attach retry budget, which is
    // working as designed — probing underneath it would tear down a socket
    // mid-retry and race a mechanism that is mid-recovery. The state this
    // exists for is the one where the terminal looks interactive and nothing
    // else is watching (#1233).
    if (this.attachState.phase !== 'attached') {
      onSettled?.();
      return;
    }
    const live = this.agentTerminalApi;
    if (!live) {
      onSettled?.();
      return;
    }
    live
      .ping(P2P_PROBE_TIMEOUT_MS)
      .catch(() => {
        // Disarmed, or the transport was swapped while this ping was in
        // flight: either way the deadline that just expired belongs to a
        // socket that is already being replaced, and acting on it would
        // schedule a second reconnect on top of the running one.
        if (this.livenessProbeToken !== token) {
          return;
        }
        this.agentWs?.reportUnresponsive();
      })
      .finally(() => {
        onSettled?.();
      });
  }

  private stopLivenessProbe(): void {
    this.livenessProbeToken += 1;
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Non-credit evidence only; not a synchronized cursor. */
  get relaySubscriptionProofSnapshot(): RelaySubscriptionProof | null {
    return !this.disposed && this.effectiveForcedRelay && this.attachState.phase === 'attached'
      && this.config.serverConnection?.isReady() ? this.relayProof : null;
  }

  private revokeRelayProof(): void {
    this.relayBeginWire = null;
    this.relayProof = null;
  }

  private teardownRelayServerHandler(): void {
    this.relayServerUnsub?.();
    this.relayServerUnsub = null;
    this.relayReadyUnsub?.();
    this.relayReadyUnsub = null;
  }

  private wireRelayServerHandler(): void {
    this.teardownRelayServerHandler();
    const conn = this.config.serverConnection;
    if (!this.effectiveForcedRelay || !conn || !this.config.attachInfo) {
      return;
    }

    this.relayReadyUnsub = conn.onRelayReady?.(this.config.sessionName, (proof, physicalGeneration) => {
      const sent = this.relayBeginWire;
      if (this.disposed || !this.effectiveForcedRelay || !conn.isReady()
        || this.attachState.phase !== 'attached' || !sent || this.relayProof
        || sent.id !== proof.relayRequestId
        || sent.physicalGeneration !== physicalGeneration
        || this.config.sessionName !== proof.sessionName
        || proof.browserClientId !== getOrCreateClientId()) {
        return; // stale route, foreign browser, missing begin, duplicate or legacy
      }
      // A relay proof names the Agent stream this route is bound to. If it is a
      // different epoch than the last one this runtime adopted, the buffer may
      // be holding a timeline the new Agent cannot replay (#2194).
      this.adoptStreamEpoch(proof.streamEpoch);
      this.relayProof = proof;
      // The proof may arrive after the atomic bootstrap was parsed. It is the
      // first moment this route may submit a parser-applied ACK.
      this.submitPendingAppliedAck();
    }) ?? null;

    this.relayServerUnsub = conn.onConnectionStateChange((state: ConnectionState) => {
      if (state !== 'connected') {
        this.revokeRelayProof();
      }
      // Any loss of the server transport ends the server-side relay forwarding
      // loop: 'connecting' (first connect / handshake pending), 'reconnecting'
      // (recoverable intra-budget drop — the new transport surfaces this
      // distinctly), and 'disconnected' (budget exhausted or explicit
      // disconnect). The phase guard keeps this inert before the relay is live.
      if (state !== 'connected') {
        if (this.attachState.phase === 'attached') {
          // Relay carries an Agent-issued sequence and can resume since
          // #2043/#2050, and its parser-applied ACK is bound to the
          // Agent-minted subscription proof (#2060/#2120). The *disconnect*
          // is still treated as potentially lossy here: a route cutover
          // checkpoint is not independently proven, so output produced during
          // the gap may sit outside the retained window. Always request a
          // fresh history bootstrap on reattach; narrow this once a cutover
          // can prove its own continuity.
          this.noteStreamTruncated();
          const result = this.attachController.dispatch({ type: 'TRANSPORT_LOST' });
          this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
        }
      } else {
        // Server WS (re)established — begin (or re-begin) relay if attach is due.
        this.driveRelayAttach();
      }
    });
  }

  /**
   * Runtime-owned relay attach: begin relay when relay-capable, the viewport is
   * ready, and the attach phase is eligible. Called from updateContext,
   * applyForceRelay, the authenticated status event, and (deferred) outcome
   * transitions; phase guards make it idempotent per loss cycle.
   */
  private driveRelayAttach(): void {
    const conn = this.config.serverConnection;
    if (!conn || !this.config.attachInfo) {
      return;
    }
    if (!this.effectiveForcedRelay) {
      return; // P2P transport active — nothing to drive
    }
    if (!this.transportReady) {
      return; // shell waits for the xterm viewport
    }
    const phase = this.attachState.phase;
    if (phase === 'attached' || phase === 'idle') {
      return;
    }
    if (phase === 'failed') {
      // Relay-context recovery: a failed session re-attaches through relay.
      this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    }
    if (conn.isReady()) {
      this.beginRelayOnce();
    }
  }

  private beginRelayOnce(): void {
    const conn = this.config.serverConnection;
    if (!conn || this.attachState.phase === 'attached') {
      return;
    }
    const resize = this.lastResize;
    this.revokeRelayProof();
    const opts = {
      cols: resize?.cols,
      rows: resize?.rows,
      needsBootstrap: this.requestBootstrapForAttach(),
    };
    // Legacy continues non-credit; never fabricate an envelope id.
    if (conn.beginRelayTracked) {
      this.relayBeginWire = conn.beginRelayTracked(this.sessionId, opts);
    } else {
      conn.beginRelay(this.sessionId, opts);
    }
    const result = this.attachController.dispatch({ type: 'RELAY_BEGIN_OK' });
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
  }

  /**
   * Defer relay attach by one microtask. Outcome-driven callers run inside the
   * controller's outcome emission; dispatching RELAY_BEGIN_OK synchronously
   * would deliver the resulting 'attached' outcome to React mirrors before the
   * outcome being processed, leaving the mirror on the pre-transition phase.
   */
  private requestRelayAttach(): void {
    queueMicrotask(() => {
      if (!this.disposed) {
        this.driveRelayAttach();
      }
    });
  }

  private wireConnectionHandler(): void {
    this.teardownConnectionHandler();
    if (!this.agentWs) {
      return;
    }
    this.connectionUnsub = this.agentWs.onConnectionStateChange((next) => {
      this.emitConnectionState(next);
      if (next === 'connected') {
        // The probe only means anything while the transport *claims* to be
        // connected — that is the exact state a half-open socket hides in.
        this.startLivenessProbe();
        this.maybeStartP2PAttach();
      } else {
        // Anything else: recovery is already running, and a probe tick would
        // only race it.
        this.stopLivenessProbe();
        if (
          (next === 'reconnecting' || next === 'connecting')
          && this.attachState.phase === 'attached'
        ) {
          this.attachedTransportGeneration = null;
          // A transport loss is not evidence of a stream gap. When the
          // Session-scoped Agent stream has an epoch/cursor, replay can cover
          // output that was produced while this browser was disconnected
          // (#1619, #1213 SC-10). Keep the last applied cursor and defer the
          // bootstrap decision until resume actually reports truncation.
          // Older Agents cannot resume, so their existing bootstrap fallback
          // remains mandatory. A previously confirmed gap stays flagged.
          if (this.p2pAttachSeed?.streamEpoch === undefined) {
            this.noteStreamTruncated();
          }
          const result = this.attachController.dispatch({ type: 'TRANSPORT_LOST' });
          this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
        } else if (next === 'disconnected') {
          this.handleTerminalDisconnect();
        }
      }
    });
  }

  /**
   * Keep or rebuild the P2P agent WebSocket.
   *
   * Rebuilds (and only rebuilds) when the agent endpoint changed — candidate
   * rotation, a manual route switch, or the first sync — or when
   * `forceReconnect` is requested. A rebuild disposes the old service and
   * constructs a fresh one bound to a fresh files plugin and terminal agent
   * API. Same-endpoint updates keep the live socket and its reconnect budget.
   *
   * Teardown order matters: the in-flight attach is canceled (epoch bump)
   * BEFORE the old service is disposed, so the disposal's router rejection of
   * the pending client.attach is a no-op instead of a spurious ATTACH_ERROR.
   */
  private syncAgentConnection(opts?: { forceReconnect?: boolean }): void {
    const url = this.addressPolicy.activeUrl;
    const token = this.config.attachInfo?.connection_token;

    if (!url || !this.config.attachInfo || this.effectiveForcedRelay) {
      const hadBinding = this.agentWs !== null || this.agentTerminalApi !== null;
      this.teardownConnectionHandler();
      this.attachController.cancelActiveAttach();
      this.agentWs?.dispose();
      this.agentWs = null;
      this.agentTerminalApi = null;
      this.filesApi = null;
      // Leaving the P2P transport retires its attach seed with it: a later
      // relay attach must not apply cursors a different transport stated.
      this.p2pAttachSeed = null;
      if (hadBinding) {
        // The binding identity went away (relay flip or full teardown) —
        // listeners rewire onto whatever buildTransport() produces now.
        this.emitTransportSwap();
      }
      return;
    }

    const builtUrl = buildAgentWsUrl(url, token);
    const live = this.agentWs;
    if (live && !opts?.forceReconnect && live.getUrl() === builtUrl) {
      // Same agent endpoint: keep the live socket. The reconnect budget was
      // fixed at construction; endpoint or token changes rebuild below.
      if (live.connectionState === 'connected') {
        this.maybeStartP2PAttach();
      }
      return;
    }

    this.teardownConnectionHandler();
    this.attachController.cancelActiveAttach();
    live?.dispose();
    this.agentWs = null;
    this.agentTerminalApi = null;
    this.filesApi = null;

    const files = this.config.createFilesApi();
    const ws = new WebSocketService(builtUrl, [files], {
      maxReconnectAttempts: this.addressPolicy.maxReconnectAttempts(),
      // Only where there is nothing to rotate to. Every other route needs the
      // transport to reach `disconnected` so the policy can advance a candidate
      // or force relay; keeping those open would stall the recovery they
      // already have (#1263).
      persistentReconnect: this.addressPolicy.isManualRoute,
      // Bind the browser's stable identity before any frame this socket
      // depends on is served (#1429) — see `p2pClientAuthHandshake`.
      handshake: p2pClientAuthHandshake,
    });
    this.agentWs = ws;
    this.filesApi = files;
    this.agentTerminalApi = this.config.createTerminalAgentApi(ws);
    // Fire-and-forget like the legacy client: transport failures surface via
    // onConnectionStateChange (the router rejects in-flight requests). A
    // teardown/dispose while the socket is still opening rejects this pending
    // connect — swallow so it cannot dangle as an unhandled rejection.
    void ws.connect().catch(() => {});
    this.wireConnectionHandler();
    // A transport whose construction fails synchronously — a `WebSocket`
    // constructor that throws, an unusable URL — settles at `disconnected`
    // *inside* `connect()`, before the handler above exists. That transition
    // is what the address policy reads to advance a candidate or force Relay;
    // without it Auto strands on the dead candidate with no later state change
    // to wake it (#2156). Replay the settled state once, off this call: when
    // this build is itself a candidate rotation, the policy is running and
    // re-entering it synchronously would nest the rotation inside itself.
    if (ws.connectionState === 'disconnected') {
      queueMicrotask(() => {
        if (this.agentWs === ws && ws.connectionState === 'disconnected') {
          this.handleTerminalDisconnect();
        }
      });
    }
    // The swap is complete only now — new socket, new agent API, handler
    // wired — so this is the moment bindings may rebuild (never earlier:
    // a transport built before this point would bind the disposed socket).
    this.emitTransportSwap();
    if (ws.connectionState === 'connected') {
      this.maybeStartP2PAttach();
    }
  }
}

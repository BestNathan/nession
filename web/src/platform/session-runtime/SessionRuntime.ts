import type { AttachInfo } from '@/types';
import type { AddressPlan } from '@/shared/hooks/useAddressPlan';
import type { RelayServerHandle } from '@/platform/attach/relayServerConnection';
import { buildAgentWsUrl, WebSocketService } from '@/platform/socket';
import type { ConnectionState } from '@/platform/socket/types';
import { AddressAttachPolicy } from '@/platform/attach/AddressAttachPolicy';
import { AttachStateMachine, type AttachPhase, type AttachTransitionResult } from '@/platform/attach/AttachStateMachine';
import { SessionAttachController } from '@/platform/attach/SessionAttachController';
// Types only. The capability *factories* are injected through
// SessionRuntimeConfig instead of imported, because `platform` sits below
// `product` and `capabilities` and may not import either — while the runtime is
// genuinely below the terminal concept, which consumes it (#783). This was
// written when the module lived at `runtime/` and the layer was called `core`;
// the constraint is the same one, and it is why the type-only imports below are
// legal while a value import of the same modules would not be.
import type { FilesPlugin } from '@/capabilities/files';
import type { TerminalAgentApi } from '@/product/terminal';

export interface SessionRuntimeConfig {
  sessionId: string;
  sessionName: string;
  attachInfo: AttachInfo | null;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  forcedRelay: boolean;
  addressPlan: AddressPlan;
  /** User-initiated route identity (manual switch); resets candidate index when changed. */
  routeIntentEpoch: number;
  lastResize?: { cols: number; rows: number } | null;
  transportReady?: boolean;
  /** Relay-mode server connection — runtime re-begins relay after server reconnect. */
  serverConnection?: RelayServerHandle | null;
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
  waitingForAddressPlan: boolean;
  transportReady: boolean;
  lastResize: { cols: number; rows: number } | null;
  reconnectCount: number;
}

export type SessionRuntimeEvent =
  | { type: 'next-candidate'; activeUrl: string | null }
  | { type: 'force-relay' }
  | { type: 'transport-exhausted'; manualRoute: boolean }
  | { type: 'route-intent-changed'; phase: AttachPhase };

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
    && a.waitingForAddressPlan === b.waitingForAddressPlan
    && a.transportReady === b.transportReady
    && a.lastResize?.cols === b.lastResize?.cols
    && a.lastResize?.rows === b.lastResize?.rows
    && a.reconnectCount === b.reconnectCount;
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
  private transportReady = false;
  /** Transport generation for which client.attach succeeded. */
  private attachedTransportGeneration: number | null = null;
  /**
   * The transport dropped while this runtime was attached, so the Terminal's
   * buffer may have a hole and must not be trusted as complete.
   *
   * Output produced during the outage is not merely undelivered — it was never
   * *recorded*: the agent's stream log is written by the broadcast task it
   * spawns for a session's first subscriber, and the pane reader it consumes
   * comes from the backend created by that attach. A detached client therefore
   * leaves nothing behind to resume from, which is why
   * `agent.terminal.stream.resume` comes back with zero events after a
   * reconnect and why this cannot be repaired by replaying the stream.
   *
   * Set where `TRANSPORT_LOST` is dispatched; cleared by the next successful
   * attach.
   */
  private historyMayHaveGap = false;
  /** Latest P2P attach stream cursor from agent.attach (#1094). */
  private p2pStreamSeed: { streamEpoch?: number; streamCursor?: number } | null = null;
  private connectionUnsub: (() => void) | null = null;
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
      addressPlan: config.addressPlan,
      addressIndex: 0,
    });
    this.lastResize = config.lastResize ?? null;
    this.transportReady = config.transportReady ?? false;
    this.snapshot = this.buildSnapshot();
    this.attachController.subscribeOutcomes((result) => {
      if (result.phase === 'attached') {
        this.attachedTransportGeneration = this.transportGeneration;
        // Whatever the last outage left behind has just been repaired by this
        // attach's bootstrap (if it needed one). A later re-attach on the same
        // healthy transport must not ask again — the snapshot is a full screen
        // repaint, and re-requesting it on every attach would flicker.
        this.historyMayHaveGap = false;
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
      agentTerminalApi: this.config.forcedRelay ? null : this.agentTerminalApi,
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
    if (ready) {
      if (this.config.forcedRelay && this.attachState.phase === 'idle') {
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

  subscribeAttachOutcomes(handler: (result: AttachTransitionResult) => void): () => void {
    this.attachOutcomeListeners.add(handler);
    return () => {
      this.attachOutcomeListeners.delete(handler);
    };
  }

  get activeUrl(): string | null {
    return this.addressPolicy.activeUrl;
  }

  get waitingForAddressPlan(): boolean {
    return this.addressPolicy.isP2P && !this.config.addressPlan.ready;
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

  getP2pStreamSeed(): { streamEpoch?: number; streamCursor?: number } | null {
    return this.p2pStreamSeed;
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
   */
  private needsBootstrap(): boolean {
    return this.historyMayHaveGap || !(this.config.hasSessionOutput?.() ?? false);
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
    this.historyMayHaveGap = true;
  }

  updateContext(next: Partial<SessionRuntimeConfig>): RuntimeMirrorSnapshot {
    const routeChanged =
      next.routeIntentEpoch !== undefined
      && next.routeIntentEpoch !== this.routeIntentEpoch;
    const prevTransportReady = this.transportReady;
    this.config = { ...this.config, ...next };
    if (next.routeIntentEpoch !== undefined) {
      this.routeIntentEpoch = next.routeIntentEpoch;
    }
    if (next.lastResize !== undefined) {
      this.lastResize = next.lastResize ?? null;
    }
    if (next.transportReady !== undefined) {
      this.transportReady = next.transportReady;
    }

    this.addressPolicy.update({
      attachInfo: this.config.attachInfo,
      orderedUrls: this.config.orderedUrls,
      manualOverride: this.config.manualOverride,
      forcedRelay: this.config.forcedRelay,
      addressPlan: this.config.addressPlan,
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
    if (!prevTransportReady && this.transportReady) {
      this.maybeStartP2PAttach();
    }
    // A relay attach may be due now: forced-relay context just applied, or the
    // xterm viewport became ready while relay attach was pending.
    this.driveRelayAttach();
    this.emitSnapshot();
    return this.getMirrorSnapshot();
  }

  private applyForceRelay(): void {
    if (this.config.forcedRelay) {
      return;
    }
    this.config = { ...this.config, forcedRelay: true };
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
    this.attachedTransportGeneration = null;
    this.attachController.cancelActiveAttach();
    this.attachController.dispatch({ type: 'DISCONNECT' });
    const result = this.attachController.dispatch({ type: 'SESSION_SELECTED' });
    this.transportGeneration += 1;
    this.syncAgentConnection({ forceReconnect: true });
    this.emitRuntimeEvent({ type: 'route-intent-changed', phase: result.phase });
  }

  private maybeStartP2PAttach(): void {
    if (this.config.forcedRelay || !this.agentWs || !this.agentTerminalApi) {
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
    this.attachController.startP2PAttach({
      sessionName: this.config.sessionName,
      agentApi: this.agentTerminalApi,
      manualRoute: this.config.manualOverride !== null,
      lastResize: this.lastResize,
      needsBootstrap: this.needsBootstrap(),
      transportGeneration: this.transportGeneration,
      onAttachOk: (result) => {
        this.p2pStreamSeed = {
          streamEpoch: result.streamEpoch,
          streamCursor: result.streamCursor,
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
    this.teardownConnectionHandler();
    this.teardownRelayServerHandler();
    this.attachController.cancelActiveAttach();
    this.agentWs?.dispose();
    this.agentWs = null;
    this.agentTerminalApi = null;
    this.filesApi = null;
    this.connectionStateListeners.clear();
    this.runtimeEventListeners.clear();
    this.snapshotListeners.clear();
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
      waitingForAddressPlan: this.waitingForAddressPlan,
      transportReady: this.transportReady,
      lastResize: this.lastResize,
      reconnectCount: this.attachState.reconnectCount,
    };
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

  private teardownRelayServerHandler(): void {
    this.relayServerUnsub?.();
    this.relayServerUnsub = null;
  }

  private wireRelayServerHandler(): void {
    this.teardownRelayServerHandler();
    const conn = this.config.serverConnection;
    if (!this.config.forcedRelay || !conn || !this.config.attachInfo) {
      return;
    }

    this.relayServerUnsub = conn.onConnectionStateChange((state: ConnectionState) => {
      // Any loss of the server transport ends the server-side relay forwarding
      // loop: 'connecting' (first connect / handshake pending), 'reconnecting'
      // (recoverable intra-budget drop — the new transport surfaces this
      // distinctly), and 'disconnected' (budget exhausted or explicit
      // disconnect). The phase guard keeps this inert before the relay is live.
      if (state !== 'connected') {
        if (this.attachState.phase === 'attached') {
          // Attached when it dropped: the buffer is now suspect, so the next
          // attach must ask for a bootstrap even though it is not empty.
          this.historyMayHaveGap = true;
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
    if (!this.config.forcedRelay) {
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
    conn.beginRelay(this.sessionId, {
      cols: resize?.cols,
      rows: resize?.rows,
      needsBootstrap: this.needsBootstrap(),
    });
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
          // Attached when it dropped: the buffer is now suspect, so the next
          // attach must ask for a bootstrap even though it is not empty.
          this.historyMayHaveGap = true;
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

    if (!url || !this.config.attachInfo || this.config.forcedRelay) {
      this.teardownConnectionHandler();
      this.attachController.cancelActiveAttach();
      this.agentWs?.dispose();
      this.agentWs = null;
      this.agentTerminalApi = null;
      this.filesApi = null;
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
    if (ws.connectionState === 'connected') {
      this.maybeStartP2PAttach();
    }
  }
}

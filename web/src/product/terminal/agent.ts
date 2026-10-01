import { decodeBase64Bytes, encodeBase64 } from './base64';
import {
  readAttachControlFields,
  readControlAcquireReply,
} from './controlPayload';
import { parseStreamEvents } from '@/platform/terminal-runtime/streamApply';
import {
  decodeBootstrapMarker,
  type TerminalBootstrap,
} from '@/platform/terminal-runtime/bootstrap';
import { WIRE as ATTACH_WIRE } from '@/generated/protocol/core/agent-attach/v1';
import {
  WIRE as TERMINAL_INPUT_WIRE,
  type TerminalInputAckPayload,
} from '@/generated/protocol/core/agent-terminal-input/v1';
import { WIRE as TERMINAL_RESIZE_WIRE } from '@/generated/protocol/core/agent-terminal-resize/v1';
import { WIRE as TERMINAL_CONTROL_ACQUIRE_WIRE } from '@/generated/protocol/core/agent-terminal-control-acquire/v1';
import { WIRE as TERMINAL_STREAM_RESUME_WIRE } from '@/generated/protocol/core/agent-terminal-stream-resume/v1';
import { getOrCreateClientId } from '@/platform/socket/clientId';
import type { PluginSurface } from '@/platform/socket/types';
import type { AttachResult, TerminalSize } from './types';
import type { TerminalControlState } from './state/terminalControl';
import { createAgentControlLease } from './agentControlLease';

/**
 * Default attach timeout — must mirror `platform/attach/AttachStateMachine.ts`
 * (controller-level budget kept there for the old consumer; this one serves
 * the feature API). Do not import from the feature into runtime.
 */
export const ATTACH_TIMEOUT_MS = 10_000;

/**
 * An `error` frame the agent sent outside any request correlation — e.g. a
 * terminal I/O frame rejected because the session is gone. `notAttached`
 * flags the transient `not attached to session` race (an outbound frame that
 * crossed the attach ack), which transports may suppress while reconnecting.
 */
export interface AgentError {
  message: string;
  notAttached: boolean;
}

export interface TerminalOutputFrame {
  data: Uint8Array;
  streamEpoch?: number;
  streamSeq?: number;
  /**
   * Present when this frame is the session's **history** rather than its live
   * output (#321).
   *
   * The distinction is the client's whole part of the bootstrap contract: a
   * bootstrap **replaces** the buffer, live output appends to it. That is what
   * lets the agent re-send a session's history on every attach that needs one
   * without the client ending up with two copies of it on screen.
   *
   * The payload qualifies that replacement — a snapshot a byte ceiling cut
   * short is not a history the client may replace its buffer with (#1305).
   *
   * Absent on every live frame, which is why the field is additive and the
   * wire keeps its version — see `TerminalOutputPayload::bootstrap`.
   */
  bootstrap?: TerminalBootstrap;
}

/**
 * A `terminal.resize` frame from the agent.
 *
 * Two kinds arrive on the same wire, and the position is what tells them
 * apart (#1303). A resize the agent **recorded** carries `streamEpoch`/
 * `streamSeq`: it consumed a sequence number, so it is an event in the
 * session's stream and belongs in the same timeline as output. A resize that
 * only reports a size — the `%window-resize` echo, or a frame forwarded by the
 * Server — carries neither, and is applied on its own.
 */
export interface TerminalResizeFrame {
  cols: number;
  rows: number;
  streamEpoch?: number;
  streamSeq?: number;
}

export interface TerminalStreamResumeResult {
  streamEpoch: number;
  epochMatch: boolean;
  /**
   * The lowest stream sequence the agent can still return — the front of its
   * retained window (#1304).
   *
   * A cursor below `firstAvailableSeq - 1` has lost everything between, for
   * good, and the agent is the only party that knows where that boundary is.
   *
   * `undefined` means the agent **stated none**: an epoch mismatch (there is no
   * window for a request about another stream), or a provider built before the
   * field existed. It is not a zero standing in for a position — a zero would
   * claim sequence 0 is retained — so a consumer must read absence as "not
   * said" and decide for itself what that is worth knowing.
   */
  firstAvailableSeq?: number;
  /**
   * The agent's verdict on whether {@link events} is **every** event from
   * `afterSeq + 1` through its current cursor (#1304).
   *
   * Read as the agent's answer rather than recomputed from
   * {@link firstAvailableSeq}: recomputing means re-implementing the agent's
   * retention policy here, and reading a shorter-than-asked-for answer as whole
   * the moment that policy bounds an answer for some other reason.
   *
   * `false` is the case the field exists for. It is not the same state as an
   * empty `events` — that one is `complete: true` and means the cursor is
   * already at the head. `undefined` again means the agent said nothing.
   */
  complete?: boolean;
  events: import('@/platform/terminal-runtime/streamApply').TerminalStreamEvent[];
}

/**
 * Where the session's input cursor stands (#1307).
 *
 * A **cursor**, not a receipt: the agent writes this after bytes have reached
 * the PTY, and it means "everything at or below this chunk is applied". It is
 * not paired with any request — see {@link TerminalAgentApi.onInputAck}.
 */
export interface TerminalInputAck {
  sessionName: string;
  inputEpoch: number;
  appliedThrough: number;
  controlGeneration?: number;
}

/**
 * Where one frame's bytes sit in the session's input stream (#1307).
 *
 * `inputEpoch` is the agent's run; `seqStart`/`seqEnd` are chunk ordinals
 * within it. One xterm `onData` is one chunk, so a caller sending a single
 * event sends `seqStart === seqEnd`; the range is what a frame that coalesced
 * several events would carry.
 */
export interface TerminalInputSequence {
  inputEpoch: number;
  seqStart: number;
  seqEnd: number;
}

/**
 * Agent (P2P) terminal capability — bound to one concrete connection, so a
 * factory takes the surface rather than a plugin install (the session
 * runtime owns install timing). The wire strings are the generated bindings,
 * except two: `agent.terminal.output` — a notification the agent declares
 * next to its dispatcher, with no Protocol Unit of its own — and
 * `control.ping`, which is a control wire and so is neither a unit nor a
 * notification.
 *
 * The wire shapes mirror `terminal/ConnectionManager.ts`, which now drives
 * this API: attach optionally carries the viewport as width/height,
 * terminal I/O carries the short session_name, and terminal.output data is
 * base64 (current agent protocol).
 */
export interface TerminalAgentApi {
  /**
   * Typed `client.attach`. Converges every outcome into {@link AttachResult}
   * — never throws. An agent `error` ack maps to `{ ok: false, error }`;
   * a timeout (default {@link ATTACH_TIMEOUT_MS}, overridable) maps to
   * `{ ok: false, error: 'timeout' }`. The viewport is optional — an attach
   * without a known size (e.g. after a reconnect) omits width/height; the
   * agent keeps the previous PTY size.
   */
  attach(
    sessionName: string,
    size?: TerminalSize,
    opts?: { timeoutMs?: number; needsBootstrap?: boolean },
  ): Promise<AttachResult>;
  /**
   * Send terminal input (keystrokes) to the session — base64-encoded.
   *
   * `sequence` is present when the caller holds a cursor for this session
   * (#1307): the frame then carries the position of its bytes, and the agent's
   * acknowledgement of that position is what makes a later retry safe. Absent
   * means the sender has no position to give — an agent built before the
   * contract, a relay path whose merge would destroy one — and the frame is the
   * one-way keystroke it always was.
   */
  sendInput(sessionName: string, data: string, sequence?: TerminalInputSequence): void;
  /** Resize the remote PTY (controller only). */
  sendResize(sessionName: string, cols: number, rows: number): void;
  /** Current control lease for a session (#1095). */
  getControlState(sessionName: string): TerminalControlState;
  /** Request controller role; broadcasts `agent.terminal.control.changed`. */
  acquireControl(sessionName: string): Promise<{ ok: true; generation: number } | { ok: false; error: string }>;
  /** Session-scoped control lease updates. */
  onControlChanged(cb: (sessionName: string, state: TerminalControlState) => void): () => void;
  /** Subscribe to terminal output frames (includes optional stream seq #1094). */
  onOutput(cb: (frame: TerminalOutputFrame) => void): () => void;
  /** Fetch ordered events after a cursor for gap recovery / late attach (#1094). */
  resumeStream(
    sessionName: string,
    streamEpoch: number,
    afterSeq: number,
  ): Promise<TerminalStreamResumeResult>;
  /** Subscribe to terminal resize frames from the agent (#1303). */
  onResize(cb: (frame: TerminalResizeFrame) => void): () => void;
  /**
   * Subscribe to the agent's applied input cursor (#1307).
   *
   * Push, not reply — and the difference is the point of the contract rather
   * than a stylistic choice. The wire is a notification (`agent.terminal.input.ack`)
   * because the fact it carries is cumulative: one value accounts for every
   * chunk at or below it, so it needs no envelope id to be paired with, and the
   * relay's habit of merging a burst into the newest frame's envelope cannot
   * cost it anything.
   */
  onInputAck(cb: (ack: TerminalInputAck) => void): () => void;
  /**
   * Subscribe to uncorrelated agent `error` frames (see {@link AgentError}).
   * Errors that ack a request (e.g. `client.attach`) are consumed by the
   * request layer and reach the requester, not this surface; keepalive-ping
   * errors are dropped by the transport filter.
   */
  onError(cb: (error: AgentError) => void): () => void;
  /**
   * Keepalive probe — the agent's connection watchdog.
   *
   * Resolves when the agent answers, rejects when it does not within
   * `timeoutMs`. The two directions are different questions: the periodic
   * fire-and-forget ping below keeps the *agent's* watchdog fed, while a
   * rejection here is how a **browser** finds out its peer is gone — the only
   * client-side signal that can, because a half-open socket fires no `close`
   * (#1233).
   */
  ping(timeoutMs: number): Promise<void>;
}

type ControlLease = ReturnType<typeof createAgentControlLease>;

async function attachToSession(
  surface: PluginSurface,
  lease: ControlLease,
  sessionName: string,
  attachOpts?: { size?: TerminalSize; timeoutMs?: number; needsBootstrap?: boolean },
): Promise<AttachResult> {
  try {
    const size = attachOpts?.size;
    const reply = await surface.request(ATTACH_WIRE, {
      session_name: sessionName,
      // No size is not "80x24": it is a client that has not laid its terminal
      // out yet, and the resize is not private to it — it moves the shared
      // window, which makes an inline-drawing application repaint into the
      // history the user reads (#1265). Say so rather than let the payload's
      // placeholder speak. A size the caller does have needs no flag: absent
      // already means "authoritative".
      ...(size
        ? { width: size.cols, height: size.rows }
        : { size_known: false }),
      // Sent only when the caller has an opinion. Omitting it is not the same
      // as sending `false`: absent asks the agent to decide, and the agent's
      // rule is the one an older client already gets (#321).
      ...(attachOpts?.needsBootstrap !== undefined
        ? { needs_bootstrap: attachOpts.needsBootstrap }
        : {}),
    }, { timeoutMs: attachOpts?.timeoutMs ?? ATTACH_TIMEOUT_MS });
    const fields = readAttachControlFields(reply);
    const role =
      fields.controlRole ??
      (fields.controllerClientId === undefined
        ? 'controller'
        : lease.roleForClient(fields.controllerClientId));
    lease.setControl(sessionName, {
      role,
      generation: fields.controlGeneration,
      controllerClientId: fields.controllerClientId,
    });
    return {
      ok: true,
      controlGeneration: fields.controlGeneration,
      controlRole: role,
      controllerClientId: fields.controllerClientId,
      streamEpoch: fields.streamEpoch,
      streamCursor: fields.streamCursor,
      inputEpoch: fields.inputEpoch,
      inputAppliedThrough: fields.inputAppliedThrough,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Router timeouts reject with "Request timeout: <type>" — that exact
    // prefix is the only timeout signal; an agent error ack that merely
    // mentions "timeout" in prose is passed through verbatim.
    const error = message.startsWith('Request timeout: ') ? 'timeout' : message;
    return { ok: false, error };
  }
}

async function acquireSessionControl(
  surface: PluginSurface,
  lease: ControlLease,
  sessionName: string,
): Promise<{ ok: true; generation: number } | { ok: false; error: string }> {
  try {
    const reply = await surface.request(TERMINAL_CONTROL_ACQUIRE_WIRE, {
      session_name: sessionName,
    });
    const fields = readControlAcquireReply(reply);
    const generation = fields.generation;
    if (generation === undefined) {
      return { ok: false, error: 'missing control generation in acquire response' };
    }
    lease.setControl(sessionName, {
      role: fields.role ?? 'controller',
      generation,
      controllerClientId: fields.controllerClientId ?? getOrCreateClientId(),
    });
    return { ok: true, generation };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Read the agent's applied input cursor off the notification (#1307).
 *
 * **Both numbers or nothing.** A cursor is a position *in a run*, so an epoch
 * without a position — or a position without the run it belongs to — names no
 * position at all, and this reader drops the frame rather than invent one. That
 * is the same answer the resize reader gives to a half-stated frame, for the
 * same reason (#1303): a partially-read position is worse than none, because
 * the consumer acts on it.
 */
function subscribeInputAck(
  surface: PluginSurface,
  cb: (ack: TerminalInputAck) => void,
): () => void {
  // The wire is spelled here rather than behind a constant, and that is a
  // requirement of the check rather than a style: `just check-protocol`
  // resolves a subscription by reading a **dotted literal at the call site**,
  // and a name reached through a `const` is a name it cannot see. This was
  // measured — spelling the constant wrong left the gate green, which is the
  // #913 failure exactly: a subscription to a wire nobody emits is silent, and
  // silence is what it looks like when nothing arrives. `agent.terminal.output`
  // is spelled the same way, for the same reason.
  return surface.subscribe('agent.terminal.input.ack', (payload) => {
    const p = payload as TerminalInputAckPayload;
    if (typeof p.input_epoch !== 'number' || typeof p.applied_through !== 'number') {
      return;
    }
    cb({
      sessionName: p.session_name,
      inputEpoch: p.input_epoch,
      appliedThrough: p.applied_through,
      controlGeneration:
        typeof p.control_generation === 'number' ? p.control_generation : undefined,
    });
  });
}

export function createTerminalAgentApi(surface: PluginSurface): TerminalAgentApi {
  const lease = createAgentControlLease(surface);

  return {
    attach: (sessionName, size, opts) =>
      attachToSession(surface, lease, sessionName, {
        size,
        timeoutMs: opts?.timeoutMs,
        needsBootstrap: opts?.needsBootstrap,
      }),

    sendInput: (
      sessionName: string,
      data: string,
      sequence?: TerminalInputSequence,
    ): void => {
      if (lease.getControlState(sessionName).role === 'observer') {
        return;
      }
      const generation = lease.generationFor(sessionName);
      surface.send(TERMINAL_INPUT_WIRE, {
        session_name: sessionName,
        data: encodeBase64(data),
        ...(generation !== undefined ? { control_generation: generation } : {}),
        ...(sequence
          ? {
              input_epoch: sequence.inputEpoch,
              seq_start: sequence.seqStart,
              seq_end: sequence.seqEnd,
            }
          : {}),
      });
    },

    sendResize: (sessionName: string, cols: number, rows: number): void => {
      const state = lease.getControlState(sessionName);
      if (state.role === 'observer') {
        return;
      }
      const generation = lease.generationFor(sessionName);
      surface.send(TERMINAL_RESIZE_WIRE, {
        session_name: sessionName,
        cols,
        rows,
        ...(generation !== undefined ? { control_generation: generation } : {}),
      });
    },

    getControlState: (sessionName: string): TerminalControlState =>
      lease.getControlState(sessionName),

    acquireControl: (sessionName) =>
      acquireSessionControl(surface, lease, sessionName),

    onInputAck: (cb: (ack: TerminalInputAck) => void) => subscribeInputAck(surface, cb),

    onControlChanged: (cb) => lease.onControlChanged(cb),

    onOutput: (cb: (frame: TerminalOutputFrame) => void): (() => void) => {
      return surface.subscribe('agent.terminal.output', (payload) => {
        const p = payload as {
          data?: unknown;
          stream_epoch?: unknown;
          stream_seq?: unknown;
          bootstrap?: unknown;
        };
        const data = p.data as string | undefined;
        if (data) {
          cb({
            data: decodeBase64Bytes(data),
            streamEpoch:
              typeof p.stream_epoch === 'number' ? p.stream_epoch : undefined,
            streamSeq: typeof p.stream_seq === 'number' ? p.stream_seq : undefined,
            // Presence is the fact; the contents are the qualification. A
            // snapshot the agent had to cut short is not a history the
            // consumer may replace its buffer with, and collapsing this to a
            // boolean — which is what it used to do — threw that away at the
            // transport boundary, where no later layer could recover it
            // (#1305).
            bootstrap: decodeBootstrapMarker(p.bootstrap),
          });
        }
      });
    },

    resumeStream: async (sessionName, streamEpoch, afterSeq) => {
      const reply = await surface.request(TERMINAL_STREAM_RESUME_WIRE, {
        session_name: sessionName,
        stream_epoch: streamEpoch,
        after_seq: afterSeq,
      });
      const r = reply as Record<string, unknown>;
      // Both read by type and left `undefined` otherwise: the wire omits them
      // when the agent has nothing to state, and a coercion here (`Number(x)`
      // on a missing field is 0) would invent the position the contract
      // forbids — 0 is below every sequence a stream can have (#1304).
      const firstAvailableSeq = r.first_available_seq;
      const complete = r.complete;
      return {
        streamEpoch:
          typeof r.stream_epoch === 'number' ? r.stream_epoch : streamEpoch,
        epochMatch: r.epoch_match === true,
        firstAvailableSeq:
          typeof firstAvailableSeq === 'number' ? firstAvailableSeq : undefined,
        complete: typeof complete === 'boolean' ? complete : undefined,
        events: parseStreamEvents(r.events),
      };
    },

    onResize: (cb: (frame: TerminalResizeFrame) => void): (() => void) => {
      return surface.subscribe(TERMINAL_RESIZE_WIRE, (payload) => {
        const p = payload as {
          cols: number;
          rows: number;
          stream_epoch?: unknown;
          stream_seq?: unknown;
        };
        // Both or neither: the agent sets them together, and a frame that
        // carried only one would be a position nothing can be placed at — so
        // it is read as the level it still is rather than half-applied as an
        // event (#1303).
        const epoch = p.stream_epoch;
        const seq = p.stream_seq;
        if (typeof epoch === 'number' && typeof seq === 'number') {
          cb({ cols: p.cols, rows: p.rows, streamEpoch: epoch, streamSeq: seq });
          return;
        }
        cb({ cols: p.cols, rows: p.rows });
      });
    },

    onError: (cb: (error: AgentError) => void): (() => void) => {
      return surface.subscribe('error', (payload, raw) => {
        // Keepalive-ping errors (agent replies echoing the legacy `ka-` ids)
        // are connection watchdogs, not session errors — drop them silently
        // like the old ConnectionManager filter did.
        if (typeof raw.id === 'string' && raw.id.startsWith('ka-')) {
          return;
        }
        const message = ((payload as { message?: unknown })?.message as string) || 'Remote error';
        cb({ message, notAttached: /not attached/i.test(message) });
      });
    },

    ping: (timeoutMs: number): Promise<void> =>
      // A literal, not an imported binding, because there is no binding:
      // `control.ping` is a control wire, and control wires are not Protocol
      // Units, so `just codegen` emits no file for it.
      //
      // `request`, not `send`, and that is the correction to what used to be
      // here. It claimed `control.pong` "carries no correlation back to this
      // call" — true only of `send`, which registers nothing pending. The
      // agent's reply is `make_response(&self.id, CONTROL_PONG, ())`
      // (`crates/nession-agent/src/server/websocket.rs`), so the pong carries
      // the ping's own id, and the router resolves pending entries by id
      // alone. Awaiting it is what turns a probe into a *liveness* signal: a
      // peer that is gone never answers, and the request layer rejects.
      surface.request('control.ping', {}, { timeoutMs }).then(() => undefined),
  };
}

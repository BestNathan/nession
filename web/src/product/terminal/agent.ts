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
import { WIRE as TERMINAL_INPUT_WIRE } from '@/generated/protocol/core/agent-terminal-input/v1';
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
 * A `terminal.resize` from the agent, in the direction the agent records it
 * (#1303).
 *
 * The position is optional and **its absence is meaningful**: absent means the
 * frame has no position — a relay frame, or an agent that predates the fields —
 * which is not the same as position 0. The agent states one only on the
 * fan-out of a resize it recorded, and it records every resize it applies. So
 * a client that took absence for "the head of the stream" would place a resize
 * it cannot order against a timeline it knows nothing about; a client that
 * reads it as "outside the timeline" is right, and gets the size either way.
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
  events: import('@/platform/terminal-runtime/streamApply').TerminalStreamEvent[];
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
  /** Send terminal input (keystrokes) to the session — base64-encoded. */
  sendInput(sessionName: string, data: string): void;
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
  /**
   * Subscribe to terminal resize frames from the agent.
   *
   * The frame may or may not carry a stream position — see
   * {@link TerminalResizeFrame} — and the two cases are not interchangeable:
   * one is an event in the session's timeline and the other is a size update
   * from outside it.
   */
  onResize(cb: (frame: TerminalResizeFrame) => void): () => void;
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

export function createTerminalAgentApi(surface: PluginSurface): TerminalAgentApi {
  const lease = createAgentControlLease(surface);

  return {
    attach: (sessionName, size, opts) =>
      attachToSession(surface, lease, sessionName, {
        size,
        timeoutMs: opts?.timeoutMs,
        needsBootstrap: opts?.needsBootstrap,
      }),

    sendInput: (sessionName: string, data: string): void => {
      if (lease.getControlState(sessionName).role === 'observer') {
        return;
      }
      const generation = lease.generationFor(sessionName);
      surface.send(TERMINAL_INPUT_WIRE, {
        session_name: sessionName,
        data: encodeBase64(data),
        ...(generation !== undefined ? { control_generation: generation } : {}),
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
      return {
        streamEpoch:
          typeof r.stream_epoch === 'number' ? r.stream_epoch : streamEpoch,
        epochMatch: r.epoch_match === true,
        events: parseStreamEvents(r.events),
      };
    },

    onResize: (cb) => {
      return surface.subscribe(TERMINAL_RESIZE_WIRE, (payload) => {
        const p = payload as {
          cols: number;
          rows: number;
          stream_epoch?: unknown;
          stream_seq?: unknown;
        };
        cb({
          cols: p.cols,
          rows: p.rows,
          // Passed through as it arrived: undefined stays undefined, because
          // "no position" and "position zero" are different facts and the
          // consumer below decides on the difference (#1303).
          streamEpoch: typeof p.stream_epoch === 'number' ? p.stream_epoch : undefined,
          streamSeq: typeof p.stream_seq === 'number' ? p.stream_seq : undefined,
        });
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

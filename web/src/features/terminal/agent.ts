import { decodeBase64Bytes, encodeBase64 } from './base64';
import type { PluginSurface } from '@/services/socket/types';
import type { AttachResult, TerminalSize } from './types';

/**
 * Default attach timeout — must mirror `runtime/AttachStateMachine.ts`
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

/**
 * Agent (P2P) terminal capability — bound to one concrete connection, so a
 * factory takes the surface rather than a plugin install (the session
 * runtime owns install timing). Wire strings live only in this file.
 *
 * The wire shapes mirror `terminal/ConnectionManager.ts`, which Task 6
 * rewires onto this API: attach optionally carries the viewport as
 * width/height, terminal I/O carries the short session_name, and
 * terminal.output data is base64 (current agent protocol).
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
    opts?: { timeoutMs?: number },
  ): Promise<AttachResult>;
  /** Send terminal input (keystrokes) to the session — base64-encoded. */
  sendInput(sessionName: string, data: string): void;
  /** Resize the remote PTY. */
  sendResize(sessionName: string, cols: number, rows: number): void;
  /** Subscribe to decoded terminal output bytes (base64 frames → Uint8Array). */
  onOutput(cb: (data: Uint8Array) => void): () => void;
  /** Subscribe to terminal resize frames from the agent. */
  onResize(cb: (cols: number, rows: number) => void): () => void;
  /**
   * Subscribe to uncorrelated agent `error` frames (see {@link AgentError}).
   * Errors that ack a request (e.g. `client.attach`) are consumed by the
   * request layer and reach the requester, not this surface; keepalive-ping
   * errors are dropped by the transport filter.
   */
  onError(cb: (error: AgentError) => void): () => void;
  /** Keepalive probe — the agent's connection watchdog. */
  ping(): void;
}

export function createTerminalAgentApi(surface: PluginSurface): TerminalAgentApi {
  return {
    attach: async (
      sessionName: string,
      size?: TerminalSize,
      opts?: { timeoutMs?: number },
    ): Promise<AttachResult> => {
      try {
        await surface.request('client.attach', {
          session_name: sessionName,
          ...(size ? { width: size.cols, height: size.rows } : {}),
        }, { timeoutMs: opts?.timeoutMs ?? ATTACH_TIMEOUT_MS });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Router timeouts reject with "Request timeout: <type>" — that exact
        // prefix is the only timeout signal; an agent error ack that merely
        // mentions "timeout" in prose is passed through verbatim.
        const error = message.startsWith('Request timeout: ') ? 'timeout' : message;
        return { ok: false, error };
      }
    },

    sendInput: (sessionName: string, data: string): void => {
      surface.send('terminal.input', { session_name: sessionName, data: encodeBase64(data) });
    },

    sendResize: (sessionName: string, cols: number, rows: number): void => {
      surface.send('terminal.resize', { session_name: sessionName, cols, rows });
    },

    onOutput: (cb: (data: Uint8Array) => void): (() => void) => {
      return surface.subscribe('terminal.output', (payload) => {
        const data = (payload as { data?: unknown })?.data as string | undefined;
        if (data) {
          // Strict decode (throws on invalid base64) — see './base64' for why
          // this side is strict while server.ts (relay) is tolerant.
          cb(decodeBase64Bytes(data));
        }
      });
    },

    onResize: (cb: (cols: number, rows: number) => void): (() => void) => {
      return surface.subscribe('terminal.resize', (payload) => {
        const { cols, rows } = payload as { cols: number; rows: number };
        cb(cols, rows);
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

    ping: (): void => {
      surface.send('keepalive.ping', {});
    },
  };
}

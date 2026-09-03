import type { WebSocketPlugin, WebSocketServiceCore } from '../types';
import type { WebSocketMessage } from '../../../types';

/**
 * TerminalPlugin — fire-and-forget terminal I/O over WebSocket.
 *
 * Unlike RequestPlugin (request/response) and EventPlugin (subscription),
 * this plugin sends raw messages that don't expect correlated responses:
 * terminal input, resize events, and relay begin/end signals.
 *
 * Relay mode wraps terminal data in base64 (mirroring the server's wire
 * format); P2P mode sends plain strings.
 */
export class TerminalPlugin implements WebSocketPlugin {
  name = 'terminal';

  private core!: WebSocketServiceCore;

  install(core: WebSocketServiceCore): () => void {
    this.core = core;
    // No message subscriptions — nothing to unwind. The facade removes the
    // plugin from its registry on unregister, after which all delegation
    // throws; a retained direct plugin reference is out of contract.
    return () => {};
  }

  // ── Relay lifecycle ───────────────────────────────────────────

  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void {
    const payload: Record<string, unknown> = { session_id: sessionId };
    if (relayUrl) { payload.relay_url = relayUrl; }
    if (cols !== undefined) { payload.cols = cols; }
    if (rows !== undefined) { payload.rows = rows; }

    this.sendRaw('client.session.relay.begin', payload);
  }

  endRelay(sessionId: string): void {
    this.sendRaw('client.session.relay.end', { session_id: sessionId });
  }

  // ── P2P terminal I/O ──────────────────────────────────────────

  sendTerminalInput(sessionId: string, data: string): void {
    this.sendRaw('terminal.input', { session_id: sessionId, data });
  }

  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.sendRaw('terminal.resize', { session_id: sessionId, cols, rows });
  }

  // ── Relay terminal I/O ────────────────────────────────────────

  sendRelayInput(sessionName: string, data: string): void {
    const encoded = this.encodeBase64(data);
    this.sendRaw('terminal.input', { session_name: sessionName, data: encoded });
  }

  sendRelayResize(sessionName: string, cols: number, rows: number): void {
    this.sendRaw('terminal.resize', { session_name: sessionName, cols, rows });
  }

  // ── Helpers ────────────────────────────────────────────────────

  private sendRaw(type: string, payload: Record<string, unknown>): void {
    const message: WebSocketMessage = {
      msg_type: type,
      id: this.core.generateMessageId(),
      timestamp: Date.now(),
      payload,
    };
    this.core.send(message);
  }

  /**
   * Encode terminal data as base64 for relay mode.
   * Relay mode wraps raw bytes in base64; P2P mode sends plain strings.
   */
  private encodeBase64(data: string): string {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

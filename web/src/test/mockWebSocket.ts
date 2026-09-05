import { vi } from 'vitest';

interface MockWsFrame {
  data: string | ArrayBuffer;
}

/**
 * Minimal WebSocket double for unit tests (node environment, no DOM).
 *
 * Instances are recorded on {@link MockWebSocket.instances}. Drive the
 * lifecycle explicitly: {@link open} (server accepts), {@link serverClose}
 * (server drops), {@link message} (server frame). Transport code is stubbed
 * with this class via `globalThis.WebSocket = MockWebSocket`, so the static
 * ready-state constants are the ones the transport compares against.
 *
 * Frames are only delivered while the socket is OPEN, mirroring the browser
 * where a closed socket fires nothing further.
 */
export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MockWsFrame) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this._readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  private _readyState = MockWebSocket.CONNECTING;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  get readyState(): number {
    return this._readyState;
  }

  /** Server accepts the connection: socket becomes OPEN and onopen fires. */
  open(): void {
    this._readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  /** Server drops the connection: socket becomes CLOSED and onclose fires. */
  serverClose(): void {
    this._readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Deliver a server frame: string is treated as text, ArrayBuffer as binary. */
  message(data: string | ArrayBuffer): void {
    if (this._readyState !== MockWebSocket.OPEN) {
      return;
    }
    this.onmessage?.({ data });
  }
}

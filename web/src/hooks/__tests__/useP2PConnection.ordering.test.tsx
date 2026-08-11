import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { useP2PConnection, type P2PConnection } from '../useP2PConnection';

// ---------------------------------------------------------------------------
// Mock WebSocket that opens on the next macrotask (like a real handshake, it
// is NOT open synchronously). Mirrors the mock in useP2PConnection.test.ts.
// ---------------------------------------------------------------------------

const OriginalWebSocket = globalThis.WebSocket;
const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

interface MockWs {
  _readyState: number;
  binaryType: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let instances: MockWs[] = [];

function setupMock() {
  instances = [];
  function MockCtor(this: MockWs) {
    this._readyState = WS.CONNECTING;
    this.binaryType = 'arraybuffer';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.send = vi.fn();
    this.close = vi.fn();
    Object.defineProperty(this, 'readyState', {
      get(this: MockWs) { return this._readyState; },
      set(this: MockWs, v: number) { this._readyState = v; },
      configurable: true,
    });
    instances.push(this);
    setTimeout(() => {
      this._readyState = WS.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }
  (MockCtor as unknown as { OPEN: number }).OPEN = WS.OPEN;
  (MockCtor as unknown as { CONNECTING: number }).CONNECTING = WS.CONNECTING;
  globalThis.WebSocket = MockCtor as unknown as typeof WebSocket;
}

// ---------------------------------------------------------------------------
// A parent/child tree that reproduces the FileBrowser ordering:
//   - Parent starts with null options (address plan resolving), then flips to
//     a URL — exactly what TerminalView does when the active P2P URL resolves.
//   - Child mounts the same render the connection object appears and, in its
//     mount effect (which runs BEFORE the parent's connect effect), issues a
//     waitForConnection() — like FileBrowser's load-on-mount listDir().
// The child records whether that first wait rejected.
// ---------------------------------------------------------------------------

const outcome = { rejected: false, resolved: false, err: '' };

function Child({ conn }: { conn: P2PConnection }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) { return; }
    firedRef.current = true;
    conn
      .waitForConnection(5_000)
      .then(() => { outcome.resolved = true; })
      .catch((e: Error) => { outcome.rejected = true; outcome.err = e.message; });
  }, [conn]);
  return null;
}

function Parent() {
  const [ready, setReady] = useState(false);
  // Flip null → url after first commit, mimicking useAddressPlan resolving.
  useEffect(() => { setReady(true); }, []);
  const conn = useP2PConnection(
    ready ? { agentUrl: 'ws://agent:9090/ws', sessionName: 's' } : null,
  );
  return conn ? <Child conn={conn} /> : null;
}

describe('P2P connection lifecycle ordering (issue #51)', () => {
  beforeEach(() => {
    setupMock();
    outcome.rejected = false;
    outcome.resolved = false;
    outcome.err = '';
  });
  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('a child waitForConnection() issued on the null→url render does NOT reject "Connection lost"', async () => {
    render(<Parent />);

    // Let the null→url flip, child mount, and socket open all settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    await waitFor(() => expect(outcome.resolved).toBe(true));
    // The core regression assertion: the mount-time wait must never have
    // rejected on the stale 'disconnected'.
    expect(outcome.rejected).toBe(false);
    expect(outcome.err).not.toBe('Connection lost');
  });
});

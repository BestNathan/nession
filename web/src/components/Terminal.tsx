import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { IDisposable } from '@xterm/xterm';
import throttle from 'lodash.throttle';
import '@xterm/xterm/css/xterm.css';
import type { WebSocketService } from '../services/websocket';
import type { P2PConnection } from '../hooks/useP2PConnection';

// Simple unique ID generator for agent protocol messages
let _msgCounter = 0;
function generateId(): string {
  return `web-${Date.now()}-${++_msgCounter}`;
}

// Base64 encode a string (handles UTF-8 via TextEncoder)
function encodeB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Base64 decode to string (handles UTF-8 via TextDecoder)
function decodeB64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Imperative methods exposed by the Terminal component via ref. */
export interface TerminalHandle {
  /**
   * Send text to the attached session as if typed. Works in both P2P and
   * relay modes. No-op if the underlying connection is not open.
   */
  sendText: (text: string) => void;
}

export interface TerminalProps {
  /** The tmux session ID (agent_id:session_name) for relay mode */
  sessionId: string;
  /** The short tmux session name (without agent prefix) for P2P agent protocol */
  sessionName: string;
  /** Connection mode: 'p2p' for direct agent connection, 'relay' via server */
  mode: 'p2p' | 'relay';
  /** P2P connection managed externally via useP2PConnection hook. Present in P2P mode, absent in relay mode. */
  p2pConnection?: P2PConnection | null;
  /** Pre-authenticated server connection for relay mode */
  serverConnection?: WebSocketService;
  /** Called when the WebSocket disconnects unexpectedly */
  onDisconnect?: () => void;
  /** Called when a connection or runtime error occurs */
  onError?: (error: Error) => void;
}

/**
 * Interactive terminal component powered by xterm.js.
 *
 * Connects to either an agent directly (P2P mode) or through the server
 * as a relay (relay mode), and bridges keyboard input / display output
 * between xterm.js and the remote tmux session over WebSocket.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    sessionId,
    sessionName,
    mode,
    p2pConnection,
    serverConnection,
    onDisconnect,
    onError,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Holds the live "send text to remote" closure, assigned inside the connection
  // effect once the transport is established. Lets the imperative handle (and the
  // keystroke path) reuse one mode-aware sender. Null when not connected.
  const sendDataRef = useRef<((data: string) => void) | null>(null);

  // Ref to latest p2pConnection so the main effect closure always accesses the
  // current value without re-running on every connectionState change.
  const p2pConnRef = useRef<P2PConnection | null>(null);
  p2pConnRef.current = p2pConnection ?? null;

  // Store xterm instances in refs so the connection-state effect (separate from
  // the main terminal-setup effect) can access them without coupling.
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Tracks whether we have sent client.attach — prevents duplicate sends on
  // repeated connectionState == 'connected' observations.
  const attachSentRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      sendText: (text: string) => {
        sendDataRef.current?.(text);
      },
    }),
    [],
  );
  // Refs to callback props avoid re-running the effect when the caller
  // passes a new inline arrow function on every render.
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  // Keep callback refs in sync without triggering the effect below.
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const reportError = useCallback((err: Error) => {
    console.error('Terminal error:', err);
    onErrorRef.current?.(err);
  }, []);

  // ---------------------------------------------------------------------------
  // P2P message subscription
  //
  // Must run synchronously (not inside the mountTimer's 50ms delay) so the
  // handler is registered before connectionState transitions to 'connected',
  // which triggers client.attach.  If the agent replies immediately there
  // would be no handler to receive the message.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'p2p' || !p2pConnection) return;

    const unsub = p2pConnection.onMessage((msg) => {
      const term = termRef.current;
      if (!term) return;

      // Binary data (synthetic __binary__ message from the hook)
      if (msg.msg_type === '__binary__') {
        term.write(new Uint8Array(msg.payload));
        return;
      }

      switch (msg.msg_type) {
        case 'terminal.output':
          if (msg.payload?.data) {
            // Agent sends base64-encoded binary data
            term.write(decodeB64(msg.payload.data));
          }
          break;
        case 'ok':
          // Response to client.attach — ignore
          break;
        case 'error':
          // Ignore errors from keepalive pings (agent doesn't
          // recognise the msg_type and sends back an error).
          if (msg.id?.startsWith('ka-')) break;
          reportError(new Error(msg.payload?.message || 'Remote error'));
          break;
        case 'keepalive.pong':
          // Server acknowledged our keepalive — connection is healthy.
          break;
        default:
          // Other message types – ignored.
          break;
      }
    });

    return unsub;
  }, [mode, p2pConnection, reportError]);

  // ---------------------------------------------------------------------------
  // P2P connection-state watcher
  //
  // Runs separately from the main terminal effect because connectionState
  // changes trigger re-renders but should *not* rebuild the xterm instance.
  //
  // Responsibilities:
  //   1. Send client.attach when the P2P WebSocket becomes connected.
  //   2. Trigger onDisconnect when the connection drops after being attached.
  //   3. Report an error when the connection fails before ever attaching.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!p2pConnection || mode !== 'p2p') return;

    // Send client.attach when we become connected.
    if (p2pConnection.connectionState === 'connected' && !attachSentRef.current) {
      attachSentRef.current = true;

      const term = termRef.current;
      if (!term) return;

      console.log('[Terminal] P2P connected, sending client.attach');
      p2pConnection.sendMessage({
        msg_type: 'client.attach',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
          session_name: sessionName,
          width: term.cols,
          height: term.rows,
        },
      });

      // Refit terminal after connection is established.
      setTimeout(() => {
        if (fitAddonRef.current && termRef.current) {
          try {
            fitAddonRef.current.fit();
            console.log('[Terminal] Refit terminal:', termRef.current.cols, 'x', termRef.current.rows);
          } catch {
            // Container may still be zero-sized in edge cases – ignore.
          }
        }
      }, 100);

      // Trigger a prompt redraw from the remote shell.
      const encoder = new TextEncoder();
      const b64 = btoa(String.fromCharCode(...encoder.encode('\r')));
      p2pConnection.sendMessage({
        msg_type: 'terminal.input',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: sessionName, data: b64 },
      });
    }

    // Call onDisconnect when the connection drops after having been attached.
    if (p2pConnection.connectionState === 'disconnected' && attachSentRef.current) {
      console.log('[Terminal] P2P connection lost');
      onDisconnectRef.current?.();
      attachSentRef.current = false;
    }
  }, [p2pConnection?.connectionState, mode, sessionName]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ---------------------------------------------------------------------------
    // 1. Create xterm.js Terminal instance with dark theme
    // ---------------------------------------------------------------------------
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b7066',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Let the browser paint once so the container has its final size,
    // then fit the terminal to the available space.
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // Container may still be zero-sized in edge cases – ignore.
      }
    });

    // Track whether this effect instance is still the "live" one.
    // React 18 StrictMode mounts twice in dev; only the second mount
    // should stay active. The earlier mount's cleanup sets this to false.
    let active = true;
    let relayUnsubOutput: (() => void) | null = null;
    let relayInputDisposable: IDisposable | null = null;
    let relayResizeDisposable: IDisposable | null = null;
    let dataDisposable: IDisposable | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let mountTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let wheelCleanup: (() => void) | null = null;

    // -------------------------------------------------------------------------
    // Scroll-wheel → viewport scrollback (not terminal escape sequences)
    //
    // tmux enables mouse tracking which causes xterm.js to forward scroll
    // events as ANSI escape sequences to the PTY.  Shells interpret those as
    // ↑/↓ keys, navigating command history instead of scrolling the viewport.
    // We intercept the wheel event on the xterm element and scroll the
    // terminal's own scrollback buffer instead.
    // -------------------------------------------------------------------------
    const handleWheel = (e: WheelEvent) => {
      const buffer = term.buffer.active;
      // Only intercept when there is scrollback content available.
      if (buffer.length <= term.rows) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (delta !== 0) term.scrollLines(delta);
    };
    // xterm.js attaches its own wheel listener to the textarea inside the
    // terminal element, so we need useCapture to intercept before xterm.
    term.element?.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    wheelCleanup = () => term.element?.removeEventListener('wheel', handleWheel, { capture: true });

    /** Send the current terminal dimensions to the remote end. */
    const sendResize = () => {
      if (!active) return;
      const { cols, rows } = term;
      try {
        if (mode === 'p2p') {
          const conn = p2pConnRef.current;
          if (conn) {
            conn.sendMessage({
              msg_type: 'terminal.resize',
              id: generateId(),
              timestamp: Math.floor(Date.now() / 1000),
              payload: { session_name: sessionName, width: cols, height: rows },
            });
          }
        } else if (mode === 'relay' && serverConnection?.isConnected()) {
          serverConnection.sendTerminalResize(sessionId, cols, rows);
        }
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    /**
     * Actually send raw text to the remote session.
     * P2P: terminal.input with base64 data + session_name.
     * Relay: serverConnection.sendTerminalInput(sessionId, data).
     * No-op if the connection is not open.
     */
    const doSendData = (data: string) => {
      try {
        if (mode === 'p2p') {
          const conn = p2pConnRef.current;
          if (conn) {
            conn.sendMessage({
              msg_type: 'terminal.input',
              id: generateId(),
              timestamp: Math.floor(Date.now() / 1000),
              payload: { session_name: sessionName, data: encodeB64(data) },
            });
          }
        } else if (serverConnection?.isConnected()) {
          serverConnection.sendTerminalInput(sessionId, data);
        }
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    /**
     * True when `data` is an ANSI mouse-tracking escape sequence.
     *
     * SGR extended mode  →  \\x1b[< … M/m  (modern terminals, generates floods)
     * Normal tracking    →  \\x1b[M …       (legacy, 3-byte payload)
     *
     * Keyboard and other control sequences pass through without throttling.
     */
    const isMouseEvent = (data: string): boolean =>
      data.startsWith('\x1b[<') || data.startsWith('\x1b[M');

    /** Mouse tracking throttle: ~60 fps — smooth motion, 17× reduction from
     *  1000+ Hz floods. Keyboard events bypass this entirely. */
    const MOUSE_THROTTLE_MS = 16;

    const sendMouseData = throttle(
      (data: string) => {
        if (active) doSendData(data);
      },
      MOUSE_THROTTLE_MS,
      { leading: true, trailing: true },
    );

    /**
     * Send raw text to the remote session.
     *
     * Mouse-tracking events (SGR \\x1b[<… / normal \\x1b[M…) are
     * throttled to 60 fps to prevent floods.  Keypresses and all other
     * escape sequences are sent immediately with zero added latency.
     */
    const sendData = (data: string) => {
      if (!active) return;
      if (isMouseEvent(data)) {
        sendMouseData(data);
      } else {
        doSendData(data);
      }
    };

    // Expose the sender to the imperative handle for the lifetime of this effect.
    sendDataRef.current = sendData;

    // ---------------------------------------------------------------------------
    // 2. Establish the WebSocket connection
    // ---------------------------------------------------------------------------
    // React 18 StrictMode in dev mode mounts → unmounts → remounts.
    // The first mount's cleanup closes the WebSocket before it can connect.
    // Use a short delay to ensure we're in the "real" mount.
    mountTimer = setTimeout(() => {
      if (!active) return; // cleanup already ran, don't connect

    if (mode === 'p2p') {
      const conn = p2pConnRef.current;
      if (!conn) {
        reportError(new Error('p2pConnection is required for P2P mode'));
        return;
      }

      // Keepalive: send WebSocket ping every 30 s to prevent idle
      // timeouts on intermediate proxies / load balancers / NAT.
      // Uses the hook's sendMessage which internally checks readyState.
      // Note: the message subscription lives in a separate useEffect
      // (above) to avoid a race with connectionState changes.

      // Keepalive: send WebSocket ping every 30 s to prevent idle
      // timeouts on intermediate proxies / load balancers / NAT.
      // Uses the hook's sendMessage which internally checks readyState.
      pingTimer = setInterval(() => {
        conn.sendMessage({
          msg_type: 'keepalive.ping',
          id: `ka-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
          payload: {},
        });
      }, 30_000);
    } else {
      // ------------------------------------------------------------------
      // Relay mode – piggy-back on the existing server WebSocket connection
      // ------------------------------------------------------------------
      if (!serverConnection) {
        reportError(new Error('serverConnection is required for relay mode'));
        return () => {
          term.dispose();
        };
      }

      // Subscribe to terminal output events for this session.
      relayUnsubOutput = serverConnection.onTerminalOutput(sessionId, (data) => {
        if (active) {
          term.write(data);
        }
      });

      // Forward keyboard input from xterm to the server.
      relayInputDisposable = term.onData((data) => {
        sendData(data);
      });

      // Forward terminal resize events, debounced to 150ms to avoid flooding
      // the server during rapid window resizes or drag operations.
      relayResizeDisposable = term.onResize(({ cols, rows }) => {
        if (!active) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            if (serverConnection?.isConnected()) {
              serverConnection.sendTerminalResize(sessionId, cols, rows);
            }
          } catch (err) {
            reportError(err instanceof Error ? err : new Error(String(err)));
          }
        }, 150);
      });

      // Send initial dimensions now that the terminal is open.
      sendResize();
    }

    }, 50); // End of mountTimer setTimeout

    // ---------------------------------------------------------------------------
    // 3. Forward keyboard input (P2P mode – relay mode handled above)
    // ---------------------------------------------------------------------------
    dataDisposable = term.onData((data) => {
      // Relay mode is wired separately above; only forward P2P keystrokes here.
      if (mode === 'p2p') {
        sendData(data);
      }
    });

    // ---------------------------------------------------------------------------
    // 4. Window resize handling (both modes)
    // ---------------------------------------------------------------------------
    const handleWindowResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!active) return;
        try {
          fitAddon.fit();
          sendResize();
        } catch {
          // Ignore fit errors during rapid resize transitions.
        }
      }, 150);
    };

    window.addEventListener('resize', handleWindowResize);

    // Give the terminal focus so the user can start typing immediately.
    term.focus();

    // ---------------------------------------------------------------------------
    // 5. Cleanup on unmount (or on prop changes that re-trigger the effect)
    // ---------------------------------------------------------------------------
    return () => {
      active = false;
      sendDataRef.current = null;
      clearTimeout(mountTimer);
      attachSentRef.current = false;

      window.removeEventListener('resize', handleWindowResize);

      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }

      sendMouseData.cancel();

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      wheelCleanup?.();

      // Dispose xterm event listeners (IDisposable objects)
      dataDisposable?.dispose();
      relayInputDisposable?.dispose();
      relayResizeDisposable?.dispose();

      // Unsubscribe relay-mode output listener or P2P message handler
      relayUnsubOutput?.();

      // P2P WebSocket is owned by the useP2PConnection hook — do not close it here.

      termRef.current = null;
      fitAddonRef.current = null;
      term.dispose();
    };
    // serverConnection is intentionally included: if the caller swaps the
    // underlying connection the terminal must reconnect through the new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionName, mode, serverConnection]);

  return (
    <div className="flex-1 min-w-0 h-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});

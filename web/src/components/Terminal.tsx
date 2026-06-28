import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { IDisposable } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './Terminal.css';
import type { WebSocketService } from '../services/websocket';

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

export interface TerminalProps {
  /** The tmux session ID (agent_id:session_name) for relay mode */
  sessionId: string;
  /** The short tmux session name (without agent prefix) for P2P agent protocol */
  sessionName: string;
  /** Connection mode: 'p2p' for direct agent connection, 'relay' via server */
  mode: 'p2p' | 'relay';
  /** Agent WebSocket URL for P2P mode (e.g. ws://192.168.1.10:8080/ws) */
  agentUrl?: string;
  /** Authentication token for P2P agent connection */
  connectionToken?: string;
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
export function Terminal({
  sessionId,
  sessionName,
  mode,
  agentUrl,
  connectionToken,
  serverConnection,
  onDisconnect,
  onError,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
    let p2pWs: WebSocket | null = null;
    let relayUnsubOutput: (() => void) | null = null;
    let relayInputDisposable: IDisposable | null = null;
    let relayResizeDisposable: IDisposable | null = null;
    let dataDisposable: IDisposable | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let mountTimer: ReturnType<typeof setTimeout> | null = null;

    /** Send the current terminal dimensions to the remote end. */
    const sendResize = () => {
      if (!active) return;
      const { cols, rows } = term;
      try {
        if (mode === 'p2p' && p2pWs?.readyState === WebSocket.OPEN) {
          p2pWs.send(
            JSON.stringify({
              msg_type: 'terminal.resize',
              id: generateId(),
              timestamp: Math.floor(Date.now() / 1000),
              payload: { session_name: sessionName, width: cols, height: rows },
            })
          );
        } else if (mode === 'relay' && serverConnection?.isConnected()) {
          serverConnection.sendTerminalResize(sessionId, cols, rows);
        }
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // ---------------------------------------------------------------------------
    // 2. Establish the WebSocket connection
    // ---------------------------------------------------------------------------
    // React 18 StrictMode in dev mode mounts → unmounts → remounts.
    // The first mount's cleanup closes the WebSocket before it can connect.
    // Use a short delay to ensure we're in the "real" mount.
    mountTimer = setTimeout(() => {
      if (!active) return; // cleanup already ran, don't connect

    if (mode === 'p2p') {
      if (!agentUrl) {
        reportError(new Error('agentUrl is required for P2P mode'));
        return;
      }
      // connectionToken is optional — agent may not require it in dev setups
      // Build the WebSocket URL with the auth token as a query parameter
      const wsUrl = connectionToken
        ? `${agentUrl}${agentUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(connectionToken)}`
        : agentUrl;

      const ws = new WebSocket(wsUrl);
      p2pWs = ws;

      console.log('[Terminal] P2P connecting to:', wsUrl);
      console.log('[Terminal] sessionName:', sessionName);
      console.log('[Terminal] connectionToken:', connectionToken ? 'present' : 'absent');

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('[Terminal] WebSocket connected, sending client.attach');
        console.log('[Terminal] active:', active);
        if (!active) {
          console.log('[Terminal] Not active, closing WebSocket');
          ws.close();
          return;
        }
        // Inform the remote end of our initial terminal size.
        // Agent protocol: first send client.attach, then terminal.input/resize
        // Use base64 for data, session_name (not session_id) for session identifier
        const attachMsg = JSON.stringify({
          msg_type: 'client.attach',
          id: generateId(),
          timestamp: Math.floor(Date.now() / 1000),
          payload: {
            session_name: sessionName,
            width: term.cols,
            height: term.rows,
          },
        });
        console.log('[Terminal] Sending client.attach:', attachMsg);
        ws.send(attachMsg);

        // Refit terminal after connection is established
        // This ensures the terminal size is correct after the container has fully rendered
        setTimeout(() => {
          if (active) {
            try {
              fitAddon.fit();
              console.log('[Terminal] Refit terminal:', term.cols, 'x', term.rows);
            } catch (e) {
              console.error('[Terminal] Refit failed:', e);
            }
          }
        }, 100);
        // Trigger a prompt redraw from the remote shell.
        const encoder = new TextEncoder();
        const b64 = btoa(String.fromCharCode(...encoder.encode('\r')));
        ws.send(
          JSON.stringify({
            msg_type: 'terminal.input',
            id: generateId(),
            timestamp: Math.floor(Date.now() / 1000),
            payload: { session_name: sessionName, data: b64 },
          })
        );
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
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
                reportError(new Error(msg.payload?.message || 'Remote error'));
                break;
              default:
                // Other message types (keep-alive, etc.) – ignored.
                break;
            }
          } else {
            // Binary payloads – write raw bytes directly to the terminal.
            term.write(new Uint8Array(event.data));
          }
        } catch (err) {
          console.error('P2P message parse error:', err);
        }
      };

      ws.onerror = (event) => {
        console.error('[Terminal] WebSocket error:', event);
        reportError(new Error('P2P WebSocket connection error'));
      };

      ws.onclose = (event) => {
        console.log('[Terminal] WebSocket closed:', event.code, event.reason);
        if (!active) return;
        onDisconnectRef.current?.();
      };
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
        if (!active) return;
        try {
          if (serverConnection?.isConnected()) {
            serverConnection.sendTerminalInput(sessionId, data);
          }
        } catch (err) {
          reportError(err instanceof Error ? err : new Error(String(err)));
        }
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
      if (!active) return;
      if (mode === 'p2p' && p2pWs?.readyState === WebSocket.OPEN) {
        p2pWs.send(
          JSON.stringify({
            msg_type: 'terminal.input',
            id: generateId(),
            timestamp: Math.floor(Date.now() / 1000),
            payload: { session_name: sessionName, data: encodeB64(data) },
          })
        );
      }
      // Relay mode onData is already wired up separately above.
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
      clearTimeout(mountTimer);

      window.removeEventListener('resize', handleWindowResize);

      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }

      // Dispose xterm event listeners (IDisposable objects)
      dataDisposable?.dispose();
      relayInputDisposable?.dispose();
      relayResizeDisposable?.dispose();

      // Unsubscribe relay-mode output listener (function returned by service)
      relayUnsubOutput?.();

      // Close the P2P WebSocket (relay mode reuses the shared connection).
      if (p2pWs) {
        p2pWs.onclose = null; // prevent onDisconnect firing during cleanup
        p2pWs.close();
        p2pWs = null;
      }

      term.dispose();
    };
    // serverConnection is intentionally included: if the caller swaps the
    // underlying connection the terminal must reconnect through the new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionName, mode, agentUrl, connectionToken, serverConnection]);

  return (
    <div className="nession-terminal">
      <div ref={containerRef} className="nession-terminal-container" />
    </div>
  );
}

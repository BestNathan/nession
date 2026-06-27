import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { IDisposable } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './Terminal.css';
import type { WebSocketService } from '../services/websocket';

export interface TerminalProps {
  /** The tmux session ID to attach to */
  sessionId: string;
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

    /** Send the current terminal dimensions to the remote end. */
    const sendResize = () => {
      if (!active) return;
      const { cols, rows } = term;
      try {
        if (mode === 'p2p' && p2pWs?.readyState === WebSocket.OPEN) {
          p2pWs.send(
            JSON.stringify({
              msg_type: 'terminal.resize',
              payload: { session_id: sessionId, width: cols, height: rows },
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
    if (mode === 'p2p') {
      if (!agentUrl) {
        reportError(new Error('agentUrl is required for P2P mode'));
        return () => {
          term.dispose();
        };
      }
      if (!connectionToken) {
        reportError(new Error('connectionToken is required for P2P mode'));
        return () => {
          term.dispose();
        };
      }

      // Build the WebSocket URL with the auth token as a query parameter
      // so the agent can authenticate the connection before any tmux data flows.
      const separator = agentUrl.includes('?') ? '&' : '?';
      const wsUrl = `${agentUrl}${separator}token=${encodeURIComponent(connectionToken)}`;

      const ws = new WebSocket(wsUrl);
      p2pWs = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (!active) {
          ws.close();
          return;
        }
        // Inform the remote end of our initial terminal size.
        sendResize();
        // Trigger a prompt redraw from the remote shell.
        ws.send(
          JSON.stringify({
            msg_type: 'terminal.input',
            payload: { session_id: sessionId, data: '\r' },
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
                  term.write(msg.payload.data);
                }
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

      ws.onerror = () => {
        reportError(new Error('P2P WebSocket connection error'));
      };

      ws.onclose = () => {
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

    // ---------------------------------------------------------------------------
    // 3. Forward keyboard input (P2P mode – relay mode handled above)
    // ---------------------------------------------------------------------------
    dataDisposable = term.onData((data) => {
      if (!active) return;
      if (mode === 'p2p' && p2pWs?.readyState === WebSocket.OPEN) {
        p2pWs.send(
          JSON.stringify({
            msg_type: 'terminal.input',
            payload: { session_id: sessionId, data },
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
  }, [sessionId, mode, agentUrl, connectionToken, serverConnection]);

  return (
    <div className="nession-terminal">
      <div ref={containerRef} className="nession-terminal-container" />
    </div>
  );
}

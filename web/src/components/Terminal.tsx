import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useState } from 'react';
import { Terminal as XTerm, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import throttle from 'lodash.throttle';
import '@xterm/xterm/css/xterm.css';
import type { WebSocketService } from '../services/websocket';
import type { ConnectionState, P2PConnection } from '../hooks/useP2PConnection';
import type { ConnectionStatus } from '../types';

// Simple unique ID generator for agent protocol messages
let _msgCounter = 0;
function generateId(): string {
  return `web-${Date.now()}-${++_msgCounter}`;
}

// Base64 encode a string (handles UTF-8 via TextEncoder)
function encodeB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {binary += String.fromCharCode(bytes[i]);}
  return btoa(binary);
}

// Base64 decode to string (handles UTF-8 via TextDecoder)
function decodeB64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i);}
  return new TextDecoder().decode(bytes);
}

type ReconnectBanner = 'none' | 'reconnecting' | 'failed';

/** Imperative methods exposed by the Terminal component via ref. */
export interface TerminalHandle {
  /**
   * Send text to the attached session as if typed. Works in both P2P and
   * relay modes. No-op if the underlying connection is not open.
   */
  sendText: (text: string) => void;
  /**
   * Refit the terminal to its container and push the new dimensions to the
   * remote session. Call this after the terminal becomes visible again (e.g.
   * switching back from a hidden tab), because xterm cannot measure itself
   * while `display:none` and may have stale dimensions.
   */
  refit: () => void;
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
  /** Called when the WebSocket disconnects after exhausting all retries */
  onDisconnect?: () => void;
  /** Called when a connection or runtime error occurs */
  onError?: (error: Error) => void;
  /** Called when the reconnection banner state changes (so parent can disable toolbar) */
  onBannerChange?: (blocked: boolean) => void;
  /** Called when Ctrl+D is pressed — should detach from the session */
  onCtrlD?: () => void;
}

/**
 * Interactive terminal component powered by xterm.js.
 *
 * Connects to either an agent directly (P2P mode) or through the server
 * as a relay (relay mode), and bridges keyboard input / display output
 * between xterm.js and the remote tmux session over WebSocket.
 *
 * When the connection drops unexpectedly, the terminal shows a
 * "Reconnecting…" banner and automatically attempts to restore the
 * link without destroying the xterm instance or its scrollback.
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
    onBannerChange,
    onCtrlD,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Holds the live "send text to remote" closure, assigned inside the connection
  // effect once the transport is established. Lets the imperative handle (and the
  // keystroke path) reuse one mode-aware sender. Null when not connected.
  const sendDataRef = useRef<((data: string) => void) | null>(null);
  // Holds the "refit terminal + push new dimensions" closure, assigned inside
  // the connection effect. Lets the imperative refit() reuse the effect's
  // fitAddon + sendResize without duplicating the mode-aware resize logic.
  const refitRef = useRef<(() => void) | null>(null);

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
  // Tracks whether we were ever successfully connected (to distinguish
  // initial connection failures from reconnection drops).
  const wasConnectedRef = useRef(false);

  // Banner state: 'none' | 'reconnecting' | 'failed'
  const [banner, setBanner] = useState<ReconnectBanner>('none');
  // Reconnect attempt count for display in the banner.
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // Track whether we're in a state where input should be blocked.
  const isBlocked = banner !== 'none';

  useImperativeHandle(
    ref,
    () => ({
      sendText: (text: string) => {
        if (!isBlocked) {
          sendDataRef.current?.(text);
        }
      },
      refit: () => {
        refitRef.current?.();
      },
    }),
    [isBlocked],
  );
  // Refs to callback props avoid re-running the effect when the caller
  // passes a new inline arrow function on every render.
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  const onBannerChangeRef = useRef(onBannerChange);

  // Keep callback refs in sync without triggering the effect below.
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onBannerChangeRef.current = onBannerChange;
  }, [onBannerChange]);

  // Notify parent when banner/blocked state changes.
  useEffect(() => {
    onBannerChangeRef.current?.(banner !== 'none');
  }, [banner]);

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
    if (mode !== 'p2p' || !p2pConnection) {return;}

    const unsub = p2pConnection.onMessage((msg) => {
      const term = termRef.current;
      if (!term) {return;}

      // Binary data (synthetic __binary__ message from the hook)
      if (msg.msg_type === '__binary__') {
        term.write(new Uint8Array(msg.payload as ArrayBuffer));
        return;
      }

      switch (msg.msg_type) {
        case 'terminal.output':
          if ((msg.payload as Record<string, unknown>)?.data) {
            // Agent sends base64-encoded binary data
            term.write(decodeB64((msg.payload as Record<string, unknown>).data as string));
          }
          break;
        case 'ok':
          // Response to client.attach — ignore
          break;
        case 'error':
          // Ignore errors from keepalive pings (agent doesn't
          // recognise the msg_type and sends back an error).
          if (msg.id?.startsWith('ka-')) {break;}
          reportError(new Error(((msg.payload as Record<string, unknown>)?.message as string) || 'Remote error'));
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
  // Attach helper — sends client.attach and triggers a prompt redraw.
  // Used for both initial connection and reconnection.
  // ---------------------------------------------------------------------------
  const doAttach = useCallback((term: XTerm, fitAddon: FitAddon, conn: P2PConnection, name: string) => {
    console.log('[Terminal] Sending client.attach');
    conn.sendMessage({
      msg_type: 'client.attach',
      id: generateId(),
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        session_name: name,
        width: term.cols,
        height: term.rows,
      },
    });

    // Refit terminal after connection is established.
    setTimeout(() => {
      try {
        fitAddon.fit();
        console.log('[Terminal] Refit terminal:', term.cols, 'x', term.rows);
      } catch {
        // Container may still be zero-sized in edge cases – ignore.
      }
    }, 100);

    // Trigger a prompt redraw from the remote shell.
    const encoder = new TextEncoder();
    const b64 = btoa(String.fromCharCode(...encoder.encode('\r')));
    conn.sendMessage({
      msg_type: 'terminal.input',
      id: generateId(),
      timestamp: Math.floor(Date.now() / 1000),
      payload: { session_name: name, data: b64 },
    });
  }, []);

  // ---------------------------------------------------------------------------
  // P2P connection-state watcher
  //
  // Runs separately from the main terminal effect because connectionState
  // changes trigger re-renders but should *not* rebuild the xterm instance.
  //
  // Responsibilities:
  //   1. Send client.attach when the P2P WebSocket becomes connected.
  //   2. Show/hide reconnection banner when connection drops/restores.
  //   3. Trigger onDisconnect after max retries exhausted.
  // ---------------------------------------------------------------------------
  const p2pState: ConnectionState | undefined = p2pConnection?.connectionState;
  const p2pReconnectAttempt = p2pConnection?.reconnectAttempt ?? 0;

  useEffect(() => {
    const conn = p2pConnRef.current;
    if (!conn || mode !== 'p2p') {return;}

    // Send client.attach when we become connected (initial or reconnected).
    if (p2pState === 'connected') {
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) {return;}

      if (!attachSentRef.current) {
        attachSentRef.current = true;
        wasConnectedRef.current = true;
        doAttach(term, fitAddon, conn, sessionName);
      }

      // Clear any banner on successful (re)connection.
      setBanner('none');
    }

    // Show reconnecting banner when connection drops after having been attached.
    if (p2pState === 'reconnecting') {
      setBanner('reconnecting');
      setReconnectAttempt(p2pReconnectAttempt);
      // Keep attachSentRef as true so we don't re-send on reconnect.
      // The actual re-attach happens in the 'connected' branch above.
      // But we need to re-send client.attach on reconnect, so reset the flag.
      attachSentRef.current = false;
    }

    // When disconnected after reconnection attempts are exhausted.
    if (p2pState === 'disconnected') {
      if (wasConnectedRef.current && banner === 'reconnecting') {
        // We were reconnecting and now disconnected — retries exhausted.
        setBanner('failed');
        attachSentRef.current = false;

        // Show failure banner for 3s then navigate away.
        setTimeout(() => {
          onDisconnectRef.current?.();
        }, 3000);
      } else if (attachSentRef.current && banner === 'none') {
        // Direct disconnect without reconnection (e.g. agent killed, no retries left).
        // This can happen when the hook's maxReconnectAttempts is set to 0.
        onDisconnectRef.current?.();
        attachSentRef.current = false;
      }
    }
  }, [p2pState, p2pReconnectAttempt, mode, sessionName, doAttach, banner]);

  // ---------------------------------------------------------------------------
  // Relay mode: subscribe to server connection changes for reconnection.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'relay' || !serverConnection) {return;}

    const unsub = serverConnection.onConnectionChange((status: ConnectionStatus) => {
      if (status === 'disconnected' || status === 'connecting') {
        // Server connection dropped — show reconnecting banner.
        if (attachSentRef.current) {
          setBanner('reconnecting');
        }
      } else if (status === 'authenticated') {
        // Server reconnected — re-attach to the session.
        if (attachSentRef.current) {
          setBanner('none');
          console.log('[Terminal] Relay reconnected, re-attaching to session:', sessionId);

          serverConnection.requestAttach(sessionId, 'relay').then((attachInfo) => {
            // Re-subscribe to terminal output for this session.
            // The existing effect handles terminal.input forwarding;
            // we just need the output subscription re-established.
            console.log('[Terminal] Relay re-attach response:', attachInfo.mode);
          }).catch((err) => {
            console.error('[Terminal] Relay re-attach failed:', err);
            reportError(err instanceof Error ? err : new Error(String(err)));
          });
        }
      }
    });

    return unsub;
  }, [mode, serverConnection, sessionId, reportError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {return;}

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
      if (buffer.length <= term.rows) {return;}
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (delta !== 0) {term.scrollLines(delta);}
    };
    // xterm.js attaches its own wheel listener to the textarea inside the
    // terminal element, so we need useCapture to intercept before xterm.
    term.element?.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    wheelCleanup = () => term.element?.removeEventListener('wheel', handleWheel, { capture: true });

    /** Send the current terminal dimensions to the remote end. */
    const sendResize = () => {
      if (!active) {return;}
      const { cols, rows } = term;
      try {
        if (mode === 'p2p') {
          const conn = p2pConnRef.current;
          if (conn && conn.connectionState === 'connected') {
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
     * No-op if the connection is not open or input is blocked.
     */
    const doSendData = (data: string) => {
      // Block input while reconnecting.
      if (isBlockedRef.current) {return;}
      try {
        if (mode === 'p2p') {
          const conn = p2pConnRef.current;
          if (conn && conn.connectionState === 'connected') {
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
        if (active) {doSendData(data);}
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
      if (!active) {return;}
      if (isMouseEvent(data)) {
        sendMouseData(data);
      } else {
        doSendData(data);
      }
    };

    // Expose the sender to the imperative handle for the lifetime of this effect.
    sendDataRef.current = sendData;

    // Expose a refit closure: fit to the (now-visible) container, then push the
    // updated dimensions to the remote session. Deferred to the next frame so
    // the browser has applied the visibility change and laid out the container
    // (fit() measures 0 while the element is still display:none).
    refitRef.current = () => {
      if (!active) {return;}
      requestAnimationFrame(() => {
        if (!active) {return;}
        try {
          fitAddon.fit();
          sendResize();
        } catch {
          // Container may be zero-sized (still hidden) — ignore.
        }
      });
    };

    // ---------------------------------------------------------------------------
    // 2. Establish the WebSocket connection
    // ---------------------------------------------------------------------------
    // React 18 StrictMode in dev mode mounts → unmounts → remounts.
    // The first mount's cleanup closes the WebSocket before it can connect.
    // Use a short delay to ensure we're in the "real" mount.
    mountTimer = setTimeout(() => {
      if (!active) {return;} // cleanup already ran, don't connect

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
        if (data === '\x04') { onCtrlD?.(); return; }
        sendData(data);
      });

      // Forward terminal resize events, debounced to 150ms to avoid flooding
      // the server during rapid window resizes or drag operations.
      relayResizeDisposable = term.onResize(({ cols, rows }) => {
        if (!active) {return;}
        if (resizeTimer) {clearTimeout(resizeTimer);}
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

      // Mark as attached so relay reconnection logic knows to re-attach.
      attachSentRef.current = true;
      wasConnectedRef.current = true;

      // Send initial dimensions now that the terminal is open.
      sendResize();
    }

    }, 50); // End of mountTimer setTimeout

    // ---------------------------------------------------------------------------
    // 3. Forward keyboard input (P2P mode – relay mode handled above)
    // ---------------------------------------------------------------------------
    dataDisposable = term.onData((data) => {
      if (mode !== 'p2p') { return; }
      if (data === '\x04') { onCtrlD?.(); return; }
      sendData(data);
    });

    // ---------------------------------------------------------------------------
    // 4. Window resize handling (both modes)
    // ---------------------------------------------------------------------------
    const handleWindowResize = () => {
      if (resizeTimer) {clearTimeout(resizeTimer);}
      resizeTimer = setTimeout(() => {
        if (!active) {return;}
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
      refitRef.current = null;
      clearTimeout(mountTimer);
      attachSentRef.current = false;
      wasConnectedRef.current = false;

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

  // Derive isBlocked from current banner state (reactive, not captured in closure).
  const isCurrentlyBlocked = banner !== 'none';
  // Re-derive sendDataRef when block state changes so doSendData can gate on it.
  // We use a ref to avoid re-creating the entire effect.
  const isBlockedRef = useRef(isCurrentlyBlocked);
  isBlockedRef.current = isCurrentlyBlocked;

  return (
    <div className="flex-1 min-w-0 h-full relative">
      {/* Reconnection banner overlay */}
      {banner !== 'none' && (
        <div
          className={
            banner === 'reconnecting'
              ? 'absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-yellow-600/90 text-yellow-50'
              : 'absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-red-600/90 text-red-50'
          }
        >
          {banner === 'reconnecting' ? (
            <>
              <span className="inline-block animate-spin">⚡</span>
              Reconnecting… (attempt {reconnectAttempt}/10)
            </>
          ) : (
            <>
              <span>⚠</span>
              Connection lost. Please reload.
            </>
          )}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full select-text" />
    </div>
  );
});

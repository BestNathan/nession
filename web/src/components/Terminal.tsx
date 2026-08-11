import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useAtom, useSetAtom } from 'jotai';
import { TerminalView, detectProfile, type TerminalHandle, type TerminalProps, type ReconnectBanner } from '../terminal';
import { detectWebGLSupport } from '../terminal/Renderer';
import { useLatest } from '../hooks/useLatest';
import {
  sessionIdAtom,
  sessionNameAtom,
  effectiveModeAtom,
  p2pConnectionAtom,
  terminalSessionStateAtom,
  lastResizeAtom,
} from '../atoms/terminal';

let _msgCounter = 0;
function generateId(): string {
  return `web-${Date.now()}-${++_msgCounter}`;
}

/** Max reconnect entries before the session is declared failed. */
const P2P_MAX_RECONNECT = 10;
/** How long to wait for client.attach ok before backing off into reconnecting. */
const ATTACH_TIMEOUT_MS = 10_000;

/**
 * Interactive terminal component powered by xterm.js.
 *
 * Thin React shell over TerminalView. The component creates a TerminalView
 * instance in a useEffect, wires state changes to React for banner rendering,
 * and exposes sendText/refit via imperative handle.
 *
 * TerminalView is rebuilt only when session identity or connection mode
 * changes. sessionId, sessionName, mode, and p2pConnection are read from the
 * jotai atoms (atoms/terminal.ts) — written by attachToSessionAtom /
 * disconnectAtom / useP2PConnection — so this component subscribes without
 * prop-drilling from TerminalView. serverConnection and relayUrl still arrive
 * via props because they are WebSocketService transport concerns, not session
 * state.
 *
 * P2P connectionState transitions (connecting → connected → reconnecting)
 * are handled internally by ConnectionManager and do NOT trigger a rebuild.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    serverConnection,
    relayUrl,
    onDisconnect,
    onError,
    onBannerChange,
    onCtrlD,
    renderer,
  },
  ref,
) {
  // Session state is owned by the atoms in ../atoms/terminal. Reading it here
  // (instead of receiving it as props) keeps Terminal in sync with the attach
  // flow and P2P connection without prop-drilling from TerminalView.
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [mode] = useAtom(effectiveModeAtom);
  const [p2pConnection] = useAtom(p2pConnectionAtom);
  const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
  const [lastResize] = useAtom(lastResizeAtom);
  const setLastResize = useSetAtom(lastResizeAtom);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  // Bump this each time viewRef.current is populated or cleared. The
  // useImperativeHandle below reads viewRef.current at build time (for the
  // fontSizeManager snapshot); without a dep to invalidate the handle when the
  // view resolves, ZoomControls would never see a non-null manager. We can't
  // depend on viewRef directly (a ref update doesn't re-render), so we track
  // its identity with a counter.
  const [viewGeneration, setViewGeneration] = useState(0);
  const [banner, setBanner] = useState<ReconnectBanner>('none');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // Keep callback refs in sync without triggering the terminal effect below.
  const onDisconnectRef = useLatest(onDisconnect);
  const onErrorRef = useLatest(onError);
  const onBannerChangeRef = useLatest(onBannerChange);
  const onCtrlDRef = useLatest(onCtrlD);

  // Notify parent when banner/blocked state changes.
  useEffect(() => {
    onBannerChangeRef.current?.(banner !== 'none');
  }, [banner, onBannerChangeRef]);

  // Mirror terminalState for callbacks that run outside the state machine
  // effect (the view.onStateChange handler in the view-creation effect below)
  // so they can read the live session state without a stale closure.
  const terminalStateRef = useRef(terminalState);
  terminalStateRef.current = terminalState;

  const reconnectCountRef = useRef(0);
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Terminal session state machine ─────────────────────────────
  // Drives every protocol decision for the session: client.attach timing,
  // relay beginRelay, reconnect banners, and the attach timeout.  Replaces
  // the old p2pState observer + ConnectionManager attach/reattach methods.
  useEffect(() => {
    const view = viewRef.current;

    switch (terminalState) {
      case 'idle':
        // Nothing to do — waiting for a session to be selected.
        break;

      case 'connecting':
        // Socket is being created (p2p) or the server ws is authenticating
        // (relay).  Clear any stale state from a previous session.
        reconnectCountRef.current = 0;
        if (mode === 'relay' && serverConnection?.isConnected()) {
          // The server ws is already authenticated — onConnectionChange only
          // fires on status CHANGE, so this covers the case where the ws came
          // up before Terminal mounted.
          setTerminalState('connected');
        }
        break;

      case 'connected': {
        if (mode === 'relay') {
          // Relay: beginRelay is fire-and-forget — once sent, the agent pushes
          // terminal.output through the server.  Session size comes from
          // lastResizeAtom (written by the ResizeObserver in the view effect).
          const w = lastResize?.cols;
          const h = lastResize?.rows;
          serverConnection?.beginRelay(sessionId, undefined, w, h);
          setTerminalState('attached');
          break;
        }

        // P2P: send client.attach and wait for the agent's ok before entering
        // 'attached'.  Input typed before the ok is buffered by
        // ConnectionManager until the session is attached.
        const conn = p2pConnection!;
        const w = lastResize?.cols;
        const h = lastResize?.rows;
        const attachId = generateId();

        conn.sendMessage({
          msg_type: 'client.attach',
          id: attachId,
          timestamp: Math.floor(Date.now() / 1000),
          payload: {
            session_name: sessionName,
            ...(w !== undefined && h !== undefined ? { width: w, height: h } : {}),
          },
        });

        // Watch for the attach ok / error response.
        const unsub = conn.onMessage((msg) => {
          if (msg.id !== attachId) { return; }
          if (msg.msg_type === 'ok') {
            setTerminalState('attached');
          } else if (msg.msg_type === 'error') {
            setTerminalState('failed');
          }
        });

        // If the agent never acks, back off into reconnecting.
        attachTimerRef.current = setTimeout(() => {
          attachTimerRef.current = null;
          unsub();
          setTerminalState('reconnecting');
        }, ATTACH_TIMEOUT_MS);

        return () => {
          unsub();
          if (attachTimerRef.current) {
            clearTimeout(attachTimerRef.current);
            attachTimerRef.current = null;
          }
        };
      }

      case 'attached':
        // Terminal I/O is live.  Clear the reconnect counter and banner.
        reconnectCountRef.current = 0;
        if (view) { view.setExternalBanner('none', 0); }
        break;

      case 'reconnecting': {
        const count = reconnectCountRef.current + 1;
        reconnectCountRef.current = count;
        if (count > P2P_MAX_RECONNECT) {
          setTerminalState('failed');
          break;
        }
        if (view) { view.setExternalBanner('reconnecting', count); }
        // The socket reconnects via useP2PConnection → p2pState → 'connected'
        // → this effect re-runs and re-attaches.
        break;
      }

      case 'failed':
        if (view) { view.setExternalBanner('failed', 0); }
        break;
    }
  }, [mode, terminalState, sessionName, sessionId, serverConnection, p2pConnection, lastResize, setTerminalState]);

  // Feed P2P transport transitions into the state machine.  connectionState is
  // a getter (no re-render on change), but this component re-renders whenever
  // the owner does — the owner (TerminalView) re-renders on every P2P state
  // transition via useP2PConnection's internal state — so reading it here in an
  // effect keyed on the value tracks it correctly.  Relay mode is driven by the
  // state machine directly (serverConnection auth events), not this bridge.
  const p2pState = p2pConnection?.connectionState;
  useEffect(() => {
    if (mode !== 'p2p') { return; }
    if (p2pState === 'connected' && (terminalState === 'connecting' || terminalState === 'reconnecting')) {
      setTerminalState('connected');
    } else if ((p2pState === 'reconnecting' || p2pState === 'disconnected') &&
               (terminalState === 'attached' || terminalState === 'connected')) {
      setTerminalState('reconnecting');
    }
  }, [mode, p2pState, terminalState, setTerminalState]);

  // Create/dispose TerminalView — only rebuild on session/mode change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) { return; }

    // Do NOT build the xterm view in p2p mode until the connection object
    // exists. On first render the address plan is still resolving, so
    // p2pConnectionAtom is null while effectiveModeAtom is already 'p2p'.
    // Building here would open() a connectionless terminal,
    // and one render later — when the connection resolves and this prop flips
    // null→object — the effect tears that view down. xterm's Viewport
    // constructor schedules an un-cancellable `setTimeout(syncScrollArea)`
    // during open(); if the view is disposed before that 0ms timer fires, the
    // timer reads the now-disposed RenderService's `.dimensions` and crashes
    // with "Cannot read properties of undefined (reading 'dimensions')"
    // (issue #51). Gating on the connection removes the throwaway view
    // entirely, so the view is built exactly once, with a live connection.
    if (mode === 'p2p' && !p2pConnection) { return; }

    const connOpts = mode === 'p2p'
      ? { mode: 'p2p' as const, sessionName, sessionId, p2pConnection: p2pConnection ?? undefined }
      : { mode: 'relay' as const, sessionName, sessionId, serverConnection, relayUrl };

    const profile = detectProfile(container.clientWidth || window.innerWidth);
    // A stored renderer preference of 'webgl' must still be clamped when the
    // current browser can't support it (e.g. headless server with software
    // rasteriser). Otherwise the WebGL addon loads, _renderService stays
    // undefined, and xterm's Viewport setTimeout crashes on syncScrollArea.
    const rendererType: 'webgl' | 'canvas' =
      renderer && detectWebGLSupport() ? renderer : 'canvas';
    const view = new TerminalView(container, {
      rendererType,
      deviceProfile: profile,
      targetColumns: 80,
      connection: connOpts,
    });

    view.onStateChange = (state) => {
      setBanner(state.banner);
      setReconnectAttempt(state.reconnectAttempt);
      // Feed relay auth into the state machine.  In relay mode the server ws
      // usually authenticates before Terminal mounts (onConnectionChange only
      // fires on change) — the 'connecting' case's isConnected() check handles
      // that path.  This catches the case where the ws comes up after mount.
      if (mode === 'relay' && state.isConnected && terminalStateRef.current === 'connecting') {
        setTerminalState('connected');
      }
    };
    view.onCtrlD = () => onCtrlDRef.current?.();
    view.onError = (err) => onErrorRef.current?.(err);
    view.onDisconnect = () => onDisconnectRef.current?.();

    viewRef.current = view;
    setViewGeneration((g) => g + 1);

    // ResizeObserver: detect container size changes and push to tmux.
    // The FIRST firing (on mount) is sent immediately so tmux gets the
    // correct size before attach() runs at ~50ms.  Subsequent firings
    // (user dragging the window) are debounced at 200ms to avoid flooding
    // tmux with intermediate sizes.
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    let isFirstResize = true;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const cell = view.cellDimensions;
        if (cell.width === 0 || cell.height === 0) { continue; }
        const cols = Math.max(1, Math.floor(width / cell.width));
        const rows = Math.max(1, Math.floor(height / cell.height));
        if (cols < 2 || rows < 2) { continue; }

        // Persist the viewport size so a reconnect can re-attach at the right
        // dimensions (client.attach carries width/height).
        setLastResize({ cols, rows });

        if (isFirstResize) {
          // First fire — send immediately so tmux is at the right size
          // when attach() fires at 50ms.
          isFirstResize = false;
          view.sendResize(cols, rows);
          continue;
        }

        if (resizeDebounce) { clearTimeout(resizeDebounce); }
        resizeDebounce = setTimeout(() => {
          if (!viewRef.current) { return; }
          viewRef.current.sendResize(cols, rows);
        }, 200);
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (resizeDebounce) { clearTimeout(resizeDebounce); }
      view.dispose();
      viewRef.current = null;
      setViewGeneration((g) => g + 1);
      // Clear DOM elements left by TerminalView constructor (scrollContainer + mountElement).
      // TerminalView.dispose() tears down managers/xterm but doesn't remove its DOM nodes;
      // without this, session switch leaves orphaned scroll containers that stack visually.
      container.innerHTML = '';
    };
  }, [sessionId, sessionName, mode, p2pConnection, serverConnection, relayUrl, renderer, onCtrlDRef, onDisconnectRef, onErrorRef, setLastResize, setTerminalState]);

  // Imperative handle for parent components. Depends on `viewGeneration` so
  // the handle regenerates when viewRef.current populates (via useEffect) or
  // clears (via effect cleanup) — this makes `fontSizeManager` propagate to
  // consumers instead of being snapshotted as `null` at first mount.
  const isBlocked = banner !== 'none';
  useImperativeHandle(
    ref,
    () => {
      // Read viewGeneration so ESLint knows the value is used; the actual
      // handle contents come from viewRef.current at build time.
      void viewGeneration;
      return {
        sendText: (text: string) => {
          if (!isBlocked) { viewRef.current?.sendText(text); }
        },
        refit: () => viewRef.current?.refit(),
        sendResize: (cols: number, rows: number) => {
          viewRef.current?.sendResize(cols, rows);
        },
        fontSizeManager: viewRef.current?.fontSizeManager ?? null,
        focusTerminal: () => viewRef.current?.focus(),
      };
    },
    [isBlocked, viewGeneration],
  );

  return (
    <div className="flex-1 min-w-0 min-h-0 relative">
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
              <span className="inline-block animate-spin">{'⚡'}</span>
              Reconnecting… (attempt {reconnectAttempt}/10)
            </>
          ) : (
            <>
              <span>{'⚠'}</span>
              Connection lost. Please reload.
            </>
          )}
        </div>
      )}
      {/* Mount point for xterm. A terminal-coloured background paints whatever
          part of the scroll container is not covered by the mount element
          (mount is sized to exactly cols*cellW × rows*cellH by
          TerminalSizeManager, so anything larger than the tmux pane fills
          with this colour instead of exposing the page background). Only
          background-color is set — it does NOT change the box model, so
          (unlike display:flex) it can't race with xterm's renderer init
          during terminal.open(). */}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ backgroundColor: '#1e1e2e' }}
      />
    </div>
  );
});

export type { TerminalHandle, TerminalProps };

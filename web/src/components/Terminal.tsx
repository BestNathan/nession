import { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { TerminalView, detectProfile, type TerminalHandle, type TerminalProps, type ReconnectBanner } from '../terminal';
import { detectWebGLSupport } from '../terminal/Renderer';
import { useLatest } from '../hooks/useLatest';

/**
 * Interactive terminal component powered by xterm.js.
 *
 * Thin React shell over TerminalView. The component creates a TerminalView
 * instance in a useEffect, wires state changes to React for banner rendering,
 * and exposes sendText/refit via imperative handle.
 *
 * TerminalView is rebuilt only when session identity or connection mode
 * changes (sessionId, sessionName, mode, p2pConnection, serverConnection).
 * P2P connectionState transitions (connecting → connected → reconnecting)
 * are handled internally by ConnectionManager and do NOT trigger a rebuild.
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
    renderer,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
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

  // Observe P2P transport reconnects. connectionState is a getter (no re-render
  // on change), but this component re-renders whenever the owner does, and the
  // owner (via useP2PWithFallback) re-renders on every P2P state transition —
  // so reading it here in an effect keyed on the value tracks it correctly.
  const p2pState = p2pConnection?.connectionState;
  const prevP2pStateRef = useRef(p2pState);
  useEffect(() => {
    // Advance the tracked previous-state first, before any early return, so a
    // transient null view (during a rebuild) can't desync reconnect detection.
    const prev = prevP2pStateRef.current;
    prevP2pStateRef.current = p2pState;

    if (mode !== 'p2p') { return; }
    const view = viewRef.current;
    if (!view) { return; }

    if (p2pState === 'reconnecting') {
      view.setExternalBanner('reconnecting', p2pConnection?.reconnectAttempt ?? 0);
    } else if (p2pState === 'connected' && prev === 'reconnecting') {
      // Transport came back after a drop: clear banner and redraw tmux.
      view.setExternalBanner('none', 0);
      view.reattach();
    }
    // 'disconnected' is handled by useP2PWithFallback (address rotation / relay).
  }, [mode, p2pState, p2pConnection]);

  // Create/dispose TerminalView — only rebuild on session/mode change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) { return; }

    // Do NOT build the xterm view in p2p mode until the connection object
    // exists. On first render the address plan is still resolving, so
    // useP2PWithFallback yields p2pConnection=null while effectiveMode is
    // already 'p2p'. Building here would open() a connectionless terminal,
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
      : { mode: 'relay' as const, sessionName, sessionId, serverConnection };

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
    };
    view.onCtrlD = () => onCtrlDRef.current?.();
    view.onError = (err) => onErrorRef.current?.(err);
    view.onDisconnect = () => onDisconnectRef.current?.();

    viewRef.current = view;

    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [sessionId, sessionName, mode, p2pConnection, serverConnection, renderer, onCtrlDRef, onDisconnectRef, onErrorRef]);

  // Imperative handle for parent components.
  const isBlocked = banner !== 'none';
  useImperativeHandle(
    ref,
    () => ({
      sendText: (text: string) => {
        if (!isBlocked) { viewRef.current?.sendText(text); }
      },
      refit: () => viewRef.current?.refit(),
      fontSizeManager: viewRef.current?.fontSizeManager ?? null,
    }),
    [isBlocked],
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
      {/* Mount point for xterm. A terminal-coloured background hides the
          sub-row remainder FitAddon leaves (it floors rows, so
          containerHeight mod cellHeight px go unpainted): the leftover shows
          the terminal's own colour instead of a light strip exposing the page
          background. Only background-color is set — it does NOT change the box
          model, so (unlike display:flex) it can't race with xterm's renderer
          init during terminal.open(). */}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ backgroundColor: '#1e1e2e' }}
      />
    </div>
  );
});

export type { TerminalHandle, TerminalProps };

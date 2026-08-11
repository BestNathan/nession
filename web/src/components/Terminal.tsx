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
    relayUrl,
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
    } else if (p2pState === 'connected' && prev !== 'connected') {
      // Initial connect (or any non-reconnect transition to connected):
      // the P2P socket just opened — send client.attach to bind the
      // session.  Don't wait for the 50ms timer in TerminalView; by then
      // the user may already have typed and terminal.input would race
      // ahead of client.attach.
      view.setExternalBanner('none', 0);
      view.reattach();
    } else if (p2pState === 'connecting') {
      // User switched addresses or a fresh connect started — cancel any
      // stale 'reconnecting' banner from the previous connection attempt.
      view.setExternalBanner('none', 0);
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
  }, [sessionId, sessionName, mode, p2pConnection, serverConnection, relayUrl, renderer, onCtrlDRef, onDisconnectRef, onErrorRef]);

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

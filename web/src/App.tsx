import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  createHashRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
import { ConnectionStatus } from './types';
import { Dashboard } from './components/Dashboard';
import { LoginPage } from './components/LoginPage';
import { getToken, setToken, clearToken, getRememberPreference } from './lib/auth';
import { WebSocketContext } from './hooks/useWebSocket';
import { useVisibilityReconnect } from './hooks/useVisibilityReconnect';

const DEFAULT_SERVER_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

function App() {
  const params = new URLSearchParams(window.location.search);
  // Auto-connect when URL provides a token OR storage holds credentials
  // (including an empty string from a previous no-auth connect).
  const autoConnect = params.get('token') !== null || getToken() !== null;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    () => autoConnect ? 'connecting' : 'disconnected'
  );
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  // Track whether we've ever successfully authenticated.  Once true, the
  // dashboard stays visible through temporary disconnections (e.g. mobile
  // tab backgrounding) while the WebSocket reconnects in the background.
  // Only a deliberate logout or exhausted reconnect attempts clear this.
  const [wasEverAuthed, setWasEverAuthed] = useState(false);
  const [authToken, setAuthToken] = useState(() => {
    const t = params.get('token');
    if (t !== null) { setToken(t, false); return t; }
    return getToken() || '';
  });
  const [serverUrl, setServerUrl] = useState(
    () => params.get('server_url') || localStorage.getItem('nession_server_url') || DEFAULT_SERVER_URL
  );
  const unsubRef = useRef<(() => void) | null>(null);
  const hasAutoConnected = useRef(false);

  // Clean up WebSocket service when wsService changes (e.g. reconnect)
  useEffect(() => {
    return () => {
      if (wsService) {
        destroyWebSocketService();
      }
    };
  }, [wsService]);

  // Clean up subscription only on unmount (not during wsService transitions —
  // otherwise the callback is unsubscribed before WebSocket events fire)
  useEffect(() => {
    return () => {
      unsubRef.current?.();
    };
  }, []);

  // Internal connect logic, shared between manual and auto-connect paths.
  // `auto` = true: silent failure (no toast), only token cleared on error.
  const connectInternal = useCallback((remember: boolean, auto: boolean) => {
    setToken(authToken, remember);
    localStorage.setItem('nession_server_url', serverUrl);

    try {
      const service = createWebSocketService(serverUrl, authToken);
      setWsService(service);

      unsubRef.current?.(); // clean up previous subscription
      unsubRef.current = service.onConnectionChange((status) => {
        if (status === 'authenticated') {
          setWasEverAuthed(true);
        }
        setConnectionStatus(status);
      });

      return service.connect();
    } catch (error) {
      if (auto) { clearToken(); } else {
        toast.error(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setConnectionStatus('disconnected');
      }
      return Promise.reject(error);
    }
  }, [authToken, serverUrl]);

  const handleConnect = useCallback((remember: boolean) => {
    connectInternal(remember, false).catch(() => { /* error already toasted */ });
  }, [connectInternal]);

  // Auto-connect on mount when stored credentials or URL token present.
  // StrictMode safety: reset the dedup flag in cleanup so the second mount
  // re-runs the connect (the wsService cleanup effect destroyed the first).
  useEffect(() => {
    if (!hasAutoConnected.current && autoConnect) {
      hasAutoConnected.current = true;
      connectInternal(getRememberPreference(), true).catch(() => {
        clearToken();
        setConnectionStatus('disconnected');
      });
    }
    return () => {
      hasAutoConnected.current = false;
    };
  }, [autoConnect, connectInternal]);

  // Mobile / background-tab recovery: when the user returns to the tab,
  // trigger an immediate reconnect if the WebSocket died while suspended.
  useVisibilityReconnect(wasEverAuthed, wsService);

  const handleDisconnect = useCallback(() => {
    if (wsService) {
      destroyWebSocketService();
      setWsService(null);
      setWasEverAuthed(false);
      setConnectionStatus('disconnected');
    }
  }, [wsService]);

  // Once authenticated, keep the dashboard visible through transient
  // disconnections (e.g. mobile tab backgrounding / network flaps).
  // Only a deliberate disconnect or exhausted reconnect attempts clear
  // wasEverAuthed → login page.
  const isAuthed = wasEverAuthed
    ? connectionStatus !== 'disconnected' && wsService !== null
    : connectionStatus === 'authenticated' && wsService !== null;

  // Two distinct router shapes: login vs. authenticated dashboard.
  // The router is only recreated on auth-state transitions (login/logout),
  // which is when the URL scheme meaningfully changes.
  const loginRouter = useMemo(
    () => createHashRouter([
      {
        path: '*',
        element: (
          <LoginPage
            connectionStatus={connectionStatus}
            serverUrl={serverUrl}
            setServerUrl={setServerUrl}
            authToken={authToken}
            setAuthToken={setAuthToken}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
        ),
      },
    ]),
    [connectionStatus, serverUrl, authToken, handleConnect, handleDisconnect],
  );

  const appRouter = useMemo(
    () => createHashRouter([
      {
        element: (
          <WebSocketContext.Provider value={wsService!}>
            <Dashboard connectionStatus={connectionStatus} />
          </WebSocketContext.Provider>
        ),
        children: [
          { index: true, element: null },
          { path: 'terminal/:sessionId', element: null },
          { path: 'env', element: null },
          { path: 'login', element: <Navigate to="/" replace /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ]),
    [connectionStatus, wsService],
  );

  return <RouterProvider router={isAuthed ? appRouter : loginRouter} />;
}

export default App;

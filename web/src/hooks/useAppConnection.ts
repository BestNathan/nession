import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { createWebSocketService, destroyWebSocketService, getWebSocketService, WebSocketService } from '../services/websocket';
import { ConnectionStatus } from '../types';
import { getToken, setToken, clearToken, getRememberPreference } from '../lib/auth';
import { useVisibilityReconnect } from './useVisibilityReconnect';

const DEFAULT_SERVER_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

export function useAppConnection() {
  const params = new URLSearchParams(window.location.search);
  const autoConnect = params.get('token') !== null || getToken() !== null;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    () => autoConnect ? 'connecting' : 'disconnected',
  );
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  // Stored credentials mean we're restoring a session after refresh — skip the
  // login router until auto-connect proves the token is invalid (#424).
  const [wasEverAuthed, setWasEverAuthed] = useState(() => autoConnect);
  const [authToken, setAuthToken] = useState(() => {
    const t = params.get('token');
    if (t !== null) { setToken(t, false); return t; }
    return getToken() || '';
  });
  const [serverUrl, setServerUrl] = useState(
    () => params.get('server_url') || localStorage.getItem('nession_server_url') || DEFAULT_SERVER_URL,
  );
  const unsubRef = useRef<(() => void) | null>(null);
  const hasAutoConnected = useRef(false);

  useEffect(() => {
    return () => {
      // Only tear down the singleton if it is still this instance. Otherwise a
      // later setWsService() would have already replaced it, and destroying
      // here would close the *new* socket (StrictMode and token/status
      // updates both re-run this effect).
      if (wsService && getWebSocketService() === wsService) {
        destroyWebSocketService();
      }
    };
  }, [wsService]);

  useEffect(() => {
    return () => {
      unsubRef.current?.();
    };
  }, []);

  const connectInternal = useCallback((remember: boolean, auto: boolean) => {
    setToken(authToken, remember);
    localStorage.setItem('nession_server_url', serverUrl);

    try {
      const service = createWebSocketService(serverUrl, authToken);
      setWsService(service);

      unsubRef.current?.();
      unsubRef.current = service.onConnectionChange((status) => {
        if (status === 'authenticated') {
          setWasEverAuthed(true);
        }
        setConnectionStatus(status);
      });

      return service.connect();
    } catch (error) {
      if (auto) {
        clearToken();
      } else {
        toast.error(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setConnectionStatus('disconnected');
      }
      return Promise.reject(error);
    }
  }, [authToken, serverUrl]);

  const handleConnect = useCallback((remember: boolean) => {
    connectInternal(remember, false).catch(() => { /* error already toasted */ });
  }, [connectInternal]);

  useEffect(() => {
    if (!hasAutoConnected.current && autoConnect) {
      hasAutoConnected.current = true;
      connectInternal(getRememberPreference(), true).catch(() => {
        clearToken();
        setWasEverAuthed(false);
        setConnectionStatus('disconnected');
      });
    }
  }, [autoConnect, connectInternal]);

  useVisibilityReconnect(wasEverAuthed, wsService);

  const handleDisconnect = useCallback(() => {
    if (wsService) {
      destroyWebSocketService();
      setWsService(null);
      setWasEverAuthed(false);
      setConnectionStatus('disconnected');
    }
  }, [wsService]);

  // App shell is ready only after client.auth succeeds — never while connecting/connected.
  const isAuthenticated = connectionStatus === 'authenticated' && wsService !== null;
  // Stored credentials or a prior session: hold reconnecting UI instead of LoginPage (#424).
  const isRestoringSession =
    wasEverAuthed && connectionStatus !== 'disconnected' && !isAuthenticated;

  return {
    connectionStatus,
    wsService,
    authToken,
    setAuthToken,
    serverUrl,
    setServerUrl,
    handleConnect,
    handleDisconnect,
    isAuthenticated,
    isRestoringSession,
  };
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { WebSocketService } from '../services/socket';
import type { ConnectionState } from '../services/socket/types';
import type { AuthResponse } from '../types';
import { agentsApi } from '@/features/agents';
import { sessionsApi } from '@/features/sessions';
import { serverApi } from '@/features/server';
import { envApi } from '@/features/env';
import { commandsApi } from '@/features/commands';
import { claudeCodeApi } from '@/features/claude-code';
import { terminalServerApi } from '@/features/terminal';
import { getToken, setToken, clearToken, getRememberPreference } from '../lib/auth';
import { getOrCreateClientId } from '../services/socket/clientId';
import { useVisibilityReconnect } from './useVisibilityReconnect';

const DEFAULT_SERVER_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

// Every capability this app knows how to speak. The feature singletons bind
// to whichever service instance installs them (use() in the service
// constructor); a later service simply re-installs them with its surface.
const SERVER_CAPABILITIES = [
  agentsApi,
  sessionsApi,
  serverApi,
  envApi,
  commandsApi,
  claudeCodeApi,
  terminalServerApi,
];

export function useAppConnection() {
  const params = new URLSearchParams(window.location.search);
  const autoConnect = params.get('token') !== null || getToken() !== null;
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>(
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
  // The service instance this render currently owns. Cleanup disposes only
  // when it is still the owner — a later connectInternal() replaces the ref
  // before the effect cleanup of the superseded instance runs (StrictMode
  // and token/status updates both re-run the effects).
  const serviceRef = useRef<WebSocketService | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      // Only tear down the service if it is still this instance. Otherwise a
      // later connectInternal() would have already replaced it, and disposing
      // here would close the *new* socket (StrictMode double-mount).
      if (wsService && serviceRef.current === wsService) {
        serviceRef.current?.dispose();
        serviceRef.current = null;
      }
    };
  }, [wsService]);

  useEffect(() => {
    return () => {
      unsubRef.current?.();
    };
  }, []);

  const connectInternal = useCallback(async (remember: boolean, auto: boolean) => {
    setToken(authToken, remember);
    localStorage.setItem('nession_server_url', serverUrl);

    let service: WebSocketService | null = null;
    try {
      // A previous service (StrictMode twin, reconnect after disconnect) must
      // stop before the new one opens — two transports would race the state.
      serviceRef.current?.dispose();
      const clientId = getOrCreateClientId();
      service = new WebSocketService(serverUrl, SERVER_CAPABILITIES, {
        maxReconnectAttempts: 5,
        handshake: (surface) => surface
          .request<AuthResponse>('client.auth', { auth_token: authToken, client_id: clientId })
          .then((res) => {
            if (res.status !== 'success') {
              throw new Error(res.message || 'Authentication failed');
            }
          }),
      });
      serviceRef.current = service;
      setWsService(service);

      unsubRef.current?.();
      unsubRef.current = service.onConnectionStateChange((status) => {
        if (status === 'connected') {
          setWasEverAuthed(true);
        }
        setConnectionStatus(status);
      });

      // Await the handshake so an auth failure lands in the catch below. The
      // try used to be sync-only, letting the rejection escape to callers —
      // handleConnect swallowed it and the manual path lost its toast.
      await service.connect();
    } catch (error) {
      // A rejection from a superseded service (disposed by a newer connect or
      // by unmount) is not this attempt's failure — the successor owns the
      // outcome and surfaces its own result. Only the current owner handles
      // the error: auto-connect clears the token silently, manual connect
      // toasts and drops back to the disconnected (login) state.
      if (service === null || serviceRef.current === service) {
        if (auto) {
          clearToken();
        } else {
          toast.error(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          setConnectionStatus('disconnected');
        }
      }
      throw error;
    }
  }, [authToken, serverUrl]);

  const handleConnect = useCallback((remember: boolean) => {
    connectInternal(remember, false).catch(() => {
      // Failure already surfaced inside connectInternal (toast + state) when
      // this attempt owned the service; superseded rejections stay silent.
    });
  }, [connectInternal]);

  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    let cancelled = false;
    connectInternal(getRememberPreference(), true).catch(() => {
      if (!cancelled) {
        clearToken();
        setWasEverAuthed(false);
        setConnectionStatus('disconnected');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [autoConnect, connectInternal]);

  useVisibilityReconnect(wasEverAuthed, wsService);

  const handleDisconnect = useCallback(() => {
    if (serviceRef.current) {
      serviceRef.current.dispose();
      serviceRef.current = null;
      setWsService(null);
      setWasEverAuthed(false);
      setConnectionStatus('disconnected');
    }
  }, []);

  // App shell is ready only after the handshake succeeded — never while
  // connecting/reconnecting/disconnected. 'connected' on the transport IS the
  // post-handshake state (there is no separate 'authenticated' anymore).
  const isAuthenticated = connectionStatus === 'connected' && wsService !== null;
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

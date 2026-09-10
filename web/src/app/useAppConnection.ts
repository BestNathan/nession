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
  // Whether to restore a session on load, frozen at the first render. Reading
  // this per render would flip it true the moment a connect() writes the token
  // to storage, and the auto-connect effect below would then supersede the
  // connection that just started (#688).
  const [autoConnect] = useState(() => params.get('token') !== null || getToken() !== null);
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

      // Unsubscribed by dispose() (it clears the listener set) rather than by
      // an effect cleanup. An effect that unsubscribed on StrictMode's
      // simulated unmount would leave the live service silent — nothing would
      // ever drive this hook to 'connected' again (#697).
      service.onConnectionStateChange((status) => {
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
          // Restoring a stored session: the credentials are what failed, so
          // drop them and fall back to the login page. This sits here, not in
          // the auto-connect effect's rejection handler, so it fires on
          // ownership — an effect cleanup StrictMode also runs mid-life would
          // otherwise leave the restore flag set for the rest of the session.
          clearToken();
          setWasEverAuthed(false);
          setConnectionStatus('disconnected');
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

  // Auto-connect is a load-time action: it runs once, for the credentials the
  // page loaded with. Keeping connectInternal out of the deps (a ref holds it)
  // is what stops a token or URL edit from re-arming a connect that would
  // supersede whatever is already live.
  const connectInternalRef = useRef(connectInternal);
  // "Once" needs a ref, not just the frozen deps array: StrictMode runs every
  // effect body twice (mount→cleanup→mount) on the same instance, and the
  // second pass would start a second transport, disposing the first while its
  // socket was still CONNECTING (#697). A real remount gets a fresh ref, so
  // the restore still runs again when the page is actually reloaded.
  const autoConnectStartedRef = useRef(false);

  useEffect(() => {
    if (!autoConnect || autoConnectStartedRef.current) {
      return;
    }
    autoConnectStartedRef.current = true;

    connectInternalRef.current(getRememberPreference(), true).catch(() => {
      // Failure is surfaced inside connectInternal, on ownership — a rejection
      // from a transport a newer connect replaced stays silent.
    });
  }, [autoConnect]);

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

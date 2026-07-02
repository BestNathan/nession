import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
import { ConnectionStatus } from './types';
import { Dashboard } from './components/Dashboard';
import { LoginPage } from './components/LoginPage';

const DEFAULT_SERVER_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

function App() {
  const params = new URLSearchParams(window.location.search);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  const [authToken, setAuthToken] = useState(
    () => params.get('token') || localStorage.getItem('nession_token') || ''
  );
  const [serverUrl, setServerUrl] = useState(
    () => params.get('server_url') || localStorage.getItem('nession_server_url') || DEFAULT_SERVER_URL
  );
  const autoConnect = params.get('token') !== null;
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

  const handleConnect = useCallback(async () => {
    localStorage.setItem('nession_token', authToken);
    localStorage.setItem('nession_server_url', serverUrl);

    try {
      const service = createWebSocketService(serverUrl, authToken);
      setWsService(service);

      unsubRef.current?.(); // clean up previous subscription
      unsubRef.current = service.onConnectionChange((status) => {
        setConnectionStatus(status);
      });

      await service.connect();
    } catch (error) {
      toast.error(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setConnectionStatus('disconnected');
    }
  }, [authToken, serverUrl]);

  // Auto-connect on mount when auth token is provided via URL parameter.
  // hasAutoConnected ref ensures this only fires once per mount.
  useEffect(() => {
    if (!hasAutoConnected.current && autoConnect && authToken && connectionStatus === 'disconnected') {
      hasAutoConnected.current = true;
      handleConnect();
    }
  }, [autoConnect, authToken, connectionStatus, handleConnect]);

  const handleDisconnect = () => {
    if (wsService) {
      destroyWebSocketService();
      setWsService(null);
      setConnectionStatus('disconnected');
    }
  };

  if (connectionStatus === 'authenticated' && wsService) {
    return (
      <Dashboard
        wsService={wsService}
        connectionStatus={connectionStatus}
      />
    );
  }

  return (
    <LoginPage
      connectionStatus={connectionStatus}
      serverUrl={serverUrl}
      setServerUrl={setServerUrl}
      authToken={authToken}
      setAuthToken={setAuthToken}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
    />
  );
}

export default App;

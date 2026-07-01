import { useState, useEffect } from 'react';
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

  useEffect(() => {
    return () => {
      if (wsService) {
        destroyWebSocketService();
      }
    };
  }, [wsService]);

  useEffect(() => {
    if (autoConnect && authToken && connectionStatus === 'disconnected') {
      handleConnect();
    }
  }, []);

  const handleConnect = async () => {
    localStorage.setItem('nession_token', authToken);
    localStorage.setItem('nession_server_url', serverUrl);

    try {
      const service = createWebSocketService(serverUrl, authToken);
      setWsService(service);

      service.onConnectionChange((status) => {
        setConnectionStatus(status);
      });

      await service.connect();
    } catch (error) {
      console.error('Connection failed:', error);
      setConnectionStatus('disconnected');
    }
  };

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

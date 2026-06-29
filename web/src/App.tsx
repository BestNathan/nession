import { useState, useEffect } from 'react';
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
import { ConnectionStatus } from './types';
import { Dashboard } from './components/Dashboard';
import './App.css';

function App() {
  // Read initial values from URL params, then localStorage, then defaults
  const params = new URLSearchParams(window.location.search);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  const [authToken, setAuthToken] = useState(
    () => params.get('token') || localStorage.getItem('nession_token') || ''
  );
  const [serverUrl, setServerUrl] = useState(
    () => params.get('server_url') || localStorage.getItem('nession_server_url') || 'ws://localhost:13000/ws'
  );
  const autoConnect = params.get('token') !== null;

  useEffect(() => {
    return () => {
      if (wsService) {
        destroyWebSocketService();
      }
    };
  }, [wsService]);

  // Auto-connect if token was provided via URL param
  useEffect(() => {
    if (autoConnect && authToken && connectionStatus === 'disconnected') {
      handleConnect();
    }
  }, []);

  const handleConnect = async () => {
    // Persist to localStorage so it survives page reloads
    localStorage.setItem('nession_token', authToken);
    localStorage.setItem('nession_server_url', serverUrl);

    try {
      const service = createWebSocketService(serverUrl, authToken);
      setWsService(service);

      const unsubscribe = service.onConnectionChange((status) => {
        setConnectionStatus(status);
      });

      await service.connect();

      return unsubscribe;
    } catch (error) {
      console.error('Connection failed:', error);
      alert(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected':
        return '#4caf50';
      case 'authenticated':
        return '#2196f3';
      case 'connecting':
        return '#ff9800';
      case 'disconnected':
      default:
        return '#f44336';
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'connected':
        return 'Connected';
      case 'authenticated':
        return 'Authenticated';
      case 'connecting':
        return 'Connecting...';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };

  // Once authenticated, render the Dashboard as the main view
  if (connectionStatus === 'authenticated' && wsService) {
    return (
      <Dashboard
        wsService={wsService}
        connectionStatus={connectionStatus}
      />
    );
  }

  // Otherwise show the connection form
  return (
    <div className="app">
      <h1>Nession</h1>

      <div className="card">
        <h2>Connect to Server</h2>

        <div className="status-indicator">
          <div
            className="status-dot"
            style={{ backgroundColor: getStatusColor() }}
          />
          <span className="status-text">{getStatusText()}</span>
        </div>

        <div className="form-group">
          <label htmlFor="serverUrl">Server URL:</label>
          <input
            id="serverUrl"
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            disabled={connectionStatus !== 'disconnected'}
            placeholder="ws://localhost:13000/ws"
          />
        </div>

        <div className="form-group">
          <label htmlFor="authToken">Auth Token:</label>
          <input
            id="authToken"
            type="password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            disabled={connectionStatus !== 'disconnected'}
            placeholder="Enter your auth token"
          />
        </div>

        <div className="button-group">
          <button
            onClick={handleConnect}
            disabled={connectionStatus !== 'disconnected'}
          >
            Connect
          </button>
          <button
            onClick={handleDisconnect}
            disabled={connectionStatus === 'disconnected'}
          >
            Disconnect
          </button>
        </div>

        <p className="info">
          {connectionStatus === 'disconnected' && 'Enter your auth token and click Connect to establish a WebSocket connection to the server.'}
          {connectionStatus === 'connecting' && 'Establishing connection to the server...'}
          {connectionStatus === 'connected' && 'Connected! Authenticating...'}
        </p>
      </div>

      <div className="card">
        <h2>Features</h2>
        <ul className="feature-list">
          <li>&#x2713; Real-time dashboard with agents and sessions overview</li>
          <li>&#x2713; WebSocket connection management with auto-reconnect</li>
          <li>&#x2713; P2P and relay terminal session support</li>
          <li>&#x2713; Live agent and session updates via events</li>
          <li>&#x2713; Full-screen terminal with xterm.js</li>
          <li>&#x2713; Mobile-responsive dark theme UI</li>
        </ul>
      </div>
    </div>
  );
}

export default App;

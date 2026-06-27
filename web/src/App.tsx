import { useState, useEffect } from 'react';
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
import { ConnectionStatus } from './types';
import './App.css';

function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [serverUrl, setServerUrl] = useState('ws://localhost:3000/ws');

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (wsService) {
        destroyWebSocketService();
      }
    };
  }, [wsService]);

  const handleConnect = async () => {
    if (!authToken.trim()) {
      alert('Please enter an auth token');
      return;
    }

    try {
      const service = createWebSocketService(serverUrl, authToken);
      setWsService(service);

      // Subscribe to connection status changes
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

  return (
    <div className="app">
      <h1>Nession Web UI</h1>

      <div className="card">
        <h2>WebSocket Connection</h2>

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
            placeholder="ws://localhost:3000/ws"
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
          {connectionStatus === 'authenticated' && 'Successfully connected and authenticated. Ready to manage agents and sessions.'}
        </p>
      </div>

      <div className="card">
        <h2>Features</h2>
        <ul className="feature-list">
          <li>✓ WebSocket connection management with auto-reconnect</li>
          <li>✓ Authentication with server</li>
          <li>✓ Request/response pattern for commands</li>
          <li>✓ Event subscriptions for real-time updates</li>
          <li>✓ P2P connection support for terminal sessions</li>
          <li>✓ Terminal I/O handling (input/output/resize)</li>
        </ul>
      </div>
    </div>
  );
}

export default App;

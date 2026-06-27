import { useState, useEffect } from 'react';
import { createWebSocketService, destroyWebSocketService, WebSocketService } from './services/websocket';
import { ConnectionStatus } from './types';
import { Terminal } from './components/Terminal';
import './App.css';

function App() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [wsService, setWsService] = useState<WebSocketService | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [serverUrl, setServerUrl] = useState('ws://localhost:3000/ws');

  // Terminal state
  const [sessionId, setSessionId] = useState('');
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalMode, setTerminalMode] = useState<'relay' | 'p2p'>('relay');

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
      // Also close any open terminal since the relay connection is gone.
      setShowTerminal(false);
    }
  };

  const handleOpenTerminal = () => {
    if (!sessionId.trim()) {
      alert('Please enter a session ID');
      return;
    }
    if (terminalMode === 'relay' && !wsService) {
      alert('Please connect to the server first (relay mode requires an active server connection)');
      return;
    }
    setShowTerminal(true);
  };

  const handleCloseTerminal = () => {
    setShowTerminal(false);
  };

  const handleTerminalDisconnect = () => {
    console.log('Terminal disconnected');
    setShowTerminal(false);
  };

  const handleTerminalError = (error: Error) => {
    console.error('Terminal error:', error);
    alert(`Terminal error: ${error.message}`);
    setShowTerminal(false);
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

      <div className="card">
        <h2>Terminal Session</h2>

        {!showTerminal ? (
          <>
            <div className="form-group">
              <label htmlFor="terminalMode">Connection Mode:</label>
              <select
                id="terminalMode"
                value={terminalMode}
                onChange={(e) => setTerminalMode(e.target.value as 'relay' | 'p2p')}
                disabled={showTerminal}
              >
                <option value="relay">Relay (via server)</option>
                <option value="p2p">P2P (direct to agent)</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="sessionId">Session ID:</label>
              <input
                id="sessionId"
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="e.g. agent-1:my-session"
              />
            </div>

            <div className="button-group">
              <button onClick={handleOpenTerminal} disabled={!sessionId.trim()}>
                Open Terminal
              </button>
            </div>

            <p className="info">
              {terminalMode === 'relay'
                ? 'Relay mode forwards terminal I/O through the server. Make sure you are connected and authenticated above.'
                : 'P2P mode connects directly to the agent. Requires the agent WebSocket URL and a connection token (obtained from the server attach response).'}
            </p>
          </>
        ) : (
          <>
            <div className="terminal-header">
              <span className="terminal-session-label">
                Session: <strong>{sessionId}</strong>
                <span className={`terminal-mode-badge terminal-mode-${terminalMode}`}>
                  {terminalMode.toUpperCase()}
                </span>
              </span>
              <button
                className="terminal-close-btn"
                onClick={handleCloseTerminal}
              >
                Close Terminal
              </button>
            </div>
            <div className="terminal-wrapper">
              <Terminal
                sessionId={sessionId}
                mode={terminalMode}
                serverConnection={terminalMode === 'relay' ? wsService ?? undefined : undefined}
                onDisconnect={handleTerminalDisconnect}
                onError={handleTerminalError}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;

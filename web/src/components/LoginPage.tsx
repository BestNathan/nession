import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import type { ConnectionStatus } from '../types';

interface LoginPageProps {
  connectionStatus: ConnectionStatus;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  authToken: string;
  setAuthToken: (token: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

function getStatusColor(status: ConnectionStatus): string {
  switch (status) {
    case 'authenticated': return 'bg-blue-500';
    case 'connected':     return 'bg-green-500';
    case 'connecting':    return 'bg-amber-500';
    case 'disconnected':
    default:              return 'bg-red-500';
  }
}

function getStatusText(status: ConnectionStatus): string {
  switch (status) {
    case 'authenticated': return 'Authenticated';
    case 'connected':     return 'Connected';
    case 'connecting':    return 'Connecting...';
    case 'disconnected':
    default:              return 'Disconnected';
  }
}

function getHelperText(status: ConnectionStatus): string {
  switch (status) {
    case 'disconnected':  return 'Enter your auth token and click Connect to establish a WebSocket connection to the server.';
    case 'connecting':    return 'Establishing connection to the server...';
    case 'connected':     return 'Connected! Authenticating...';
    default:              return '';
  }
}

const FEATURES = [
  'Real-time dashboard with agents and sessions overview',
  'WebSocket connection management with auto-reconnect',
  'P2P and relay terminal session support',
  'Live agent and session updates via events',
  'Full-screen terminal with xterm.js',
  'Mobile-responsive dark theme UI',
];

export function LoginPage({
  connectionStatus,
  serverUrl,
  setServerUrl,
  authToken,
  setAuthToken,
  onConnect,
  onDisconnect,
}: LoginPageProps) {
  const isConnecting = connectionStatus !== 'disconnected';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <h1 className="text-3xl font-bold mb-2">Nession</h1>
      <p className="text-muted-foreground mb-8">Distributed tmux Agent</p>

      <Card className="w-full max-w-md mb-6">
        <CardHeader>
          <CardTitle>Connect to Server</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Badge variant="outline" className="gap-1.5 py-1.5">
            <span className={`w-2 h-2 rounded-full ${getStatusColor(connectionStatus)} ${connectionStatus === 'connecting' ? 'animate-pulse' : ''}`} />
            {getStatusText(connectionStatus)}
          </Badge>

          <div className="space-y-2">
            <Label htmlFor="serverUrl">Server URL</Label>
            <Input
              id="serverUrl"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={isConnecting}
              placeholder="ws://localhost:19090/ws"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="authToken">Auth Token</Label>
            <Input
              id="authToken"
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              disabled={isConnecting}
              placeholder="Enter your auth token"
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={onConnect} disabled={isConnecting} className="flex-1">
              Connect
            </Button>
            <Button
              onClick={onDisconnect}
              disabled={connectionStatus === 'disconnected'}
              variant="destructive"
              className="flex-1"
            >
              Disconnect
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">{getHelperText(connectionStatus)}</p>
        </CardContent>
      </Card>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Features</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <span className="text-green-500 flex-shrink-0">&#10003;</span>
                {f}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { ConnectionStatusBadge } from './ui/ConnectionStatusBadge';
import { getRememberPreference, setRememberPreference } from '../lib/auth';
import type { ConnectionStatus } from '../types';

interface LoginPageProps {
  connectionStatus: ConnectionStatus;
  serverUrl: string;
  setServerUrl: (url: string) => void;
  authToken: string;
  setAuthToken: (token: string) => void;
  onConnect: (remember: boolean) => void;
  onDisconnect: () => void;
}

const HELPER_TEXT: Record<ConnectionStatus, string> = {
  disconnected: 'Enter your auth token and click Connect to establish a WebSocket connection to the server.',
  connecting: 'Establishing connection to the server...',
  connected: 'Connected! Authenticating...',
  authenticated: '',
};

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
  const [remember, setRemember] = useState(getRememberPreference());

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center p-4">
      <h1 className="text-3xl font-bold mb-2">Nession</h1>
      <p className="text-muted-foreground mb-8">Distributed tmux Agent</p>

      <Card className="w-full max-w-md mb-6">
        <CardHeader>
          <CardTitle>Connect to Server</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ConnectionStatusBadge status={connectionStatus} />

          <div className="flex flex-col gap-2">
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

          <div className="flex flex-col gap-2">
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

          <div className="flex items-center gap-2">
            <Checkbox
              id="remember"
              checked={remember}
              onCheckedChange={(checked) => {
                const value = checked === true;
                setRemember(value);
                setRememberPreference(value);
              }}
              disabled={isConnecting}
            />
            <label
              htmlFor="remember"
              className="text-sm font-normal text-muted-foreground cursor-pointer"
            >
              Remember me
            </label>
          </div>

          <div className="flex gap-2">
            <Button onClick={() => onConnect(remember)} disabled={isConnecting} className="flex-1">
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

          <p className="text-sm text-muted-foreground">{HELPER_TEXT[connectionStatus]}</p>
        </CardContent>
      </Card>

      <Card data-testid="features-card" className="hidden md:block w-full max-w-md">
        <CardHeader>
          <CardTitle>Features</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="gap-2 text-sm">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <span className="text-success flex-shrink-0">&#10003;</span>
                {f}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

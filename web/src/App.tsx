import { createContext, useContext, useMemo, useRef } from 'react';
import {
  createHashRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { LoginPage } from './app/LoginPage';
import { WebSocketContext } from '@/shared/hooks/useWebSocket';
import { useAppConnection } from './app/useAppConnection';
import { FixtureApp } from './app/fixture/FixtureApp';
import { FixtureShell } from './app/fixture/FixtureShell';
import { FixtureWorkspace } from './app/fixture/FixtureWorkspace';
import { Shell } from './app/Shell';
import type { WebSocketService, ConnectionState } from '@/platform/socket';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

// Module-stable (static element, immutable) — safe to create once at module
// scope and reuse in both routers without a useMemo dependency.
const fixtureRoute = { path: '/fixture', element: <FixtureShell /> };
const fixtureWorkspaceRoute = { path: '/fixture/workspace', element: <FixtureWorkspace /> };
const fixtureAppRoute = { path: '/fixture/app', element: <FixtureApp /> };

function ReconnectingShell() {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center bg-background gap-3">
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>Reconnecting…</p>
    </div>
  );
}

interface LiveShellConnection {
  wsService: WebSocketService | null;
  connectionStatus: ConnectionState;
  onRetry: () => void;
}

const LiveShellContext = createContext<LiveShellConnection | null>(null);

/** Router elements are stable across transport changes; Shell owns the durable work surface. */
function ConnectedShell() {
  const connection = useContext(LiveShellContext);
  if (!connection?.wsService) { return null; }
  return (
    <WebSocketContext.Provider value={connection.wsService}>
      <Shell connectionStatus={connection.connectionStatus} onRetry={connection.onRetry} />
    </WebSocketContext.Provider>
  );
}

function App() {
  const {
    connectionStatus,
    wsService,
    authToken,
    setAuthToken,
    serverUrl,
    setServerUrl,
    handleConnect,
    handleDisconnect,
    handleRetry,
    isAuthenticated,
    isRestoringSession,
  } = useAppConnection();

  // A foreground reconnect never leaves this router or remounts the Terminal.
  const enteredShell = useRef(false);
  if (isAuthenticated) { enteredShell.current = true; }
  if (!wsService) { enteredShell.current = false; }

  const loginRouter = useMemo(
    () => createHashRouter([
      fixtureAppRoute,
      fixtureWorkspaceRoute,
      fixtureRoute,
      {
        path: '*',
        element: (
          <LoginPage
            connectionStatus={connectionStatus}
            serverUrl={serverUrl}
            setServerUrl={setServerUrl}
            authToken={authToken}
            setAuthToken={setAuthToken}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
        ),
      },
    ]),
    [connectionStatus, serverUrl, authToken, handleConnect, handleDisconnect, setAuthToken, setServerUrl],
  );

  const appRouter = useMemo(
    () => createHashRouter([
      fixtureAppRoute,
      fixtureWorkspaceRoute,
      fixtureRoute,
      {
        path: '/',
        element: (
          <ConnectedShell />
        ),
        children: [
          { index: true, element: null },
          { path: 'terminal/:sessionId', element: null },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ]),
    [],
  );

  // Only the very first auth/reload may show the boot placeholder. A Session
  // that entered Shell must remain mounted during reconnect and exhaustion.
  if (isRestoringSession && !enteredShell.current) {
    return <ReconnectingShell />;
  }

  const showShell = wsService !== null && (isAuthenticated || enteredShell.current);
  return (
    <LiveShellContext.Provider value={{ wsService, connectionStatus, onRetry: handleRetry }}>
      <RouterProvider router={showShell ? appRouter : loginRouter} />
    </LiveShellContext.Provider>
  );
}

export default App;

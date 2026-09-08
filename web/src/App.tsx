import { useMemo } from 'react';
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
import { SessionFirstShell } from './app/SessionFirstShell';

// Module-stable (static element, immutable) — safe to create once at module
// scope and reuse in both routers without a useMemo dependency.
const fixtureRoute = { path: '/fixture', element: <FixtureShell /> };
const fixtureWorkspaceRoute = { path: '/fixture/workspace', element: <FixtureWorkspace /> };
const fixtureAppRoute = { path: '/fixture/app', element: <FixtureApp /> };

function ReconnectingShell() {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center bg-background gap-3">
      <p className="text-sm text-muted-foreground">Reconnecting…</p>
    </div>
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
    isAuthenticated,
    isRestoringSession,
  } = useAppConnection();

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
          <WebSocketContext.Provider value={wsService!}>
            <SessionFirstShell connectionStatus={connectionStatus} />
          </WebSocketContext.Provider>
        ),
        children: [
          { index: true, element: null },
          { path: 'terminal/:sessionId', element: null },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ]),
    [connectionStatus, wsService],
  );

  if (isRestoringSession) {
    return <ReconnectingShell />;
  }

  return <RouterProvider router={isAuthenticated ? appRouter : loginRouter} />;
}

export default App;

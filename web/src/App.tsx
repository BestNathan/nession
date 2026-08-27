import { useMemo, useState } from 'react';
import {
  createHashRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { Dashboard } from './components/Dashboard';
import { LoginPage } from './components/LoginPage';
import { WebSocketContext } from './hooks/useWebSocket';
import { useAppConnection } from './hooks/useAppConnection';
import { isSessionFirst, setSessionFirst } from './lib/sessionFirst';
import { SessionFirstShell } from './session-first/SessionFirstShell';

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

  const [sessionFirst, setSessionFirstOn] = useState(() => isSessionFirst());

  const loginRouter = useMemo(
    () => createHashRouter([
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
      {
        path: '/',
        element: (
          <WebSocketContext.Provider value={wsService!}>
            {sessionFirst ? (
              <SessionFirstShell
                onLegacy={() => {
                  setSessionFirst(false);
                  setSessionFirstOn(false);
                }}
              />
            ) : (
              <Dashboard
                connectionStatus={connectionStatus}
                onSessionFirst={() => {
                  setSessionFirst(true);
                  setSessionFirstOn(true);
                }}
              />
            )}
          </WebSocketContext.Provider>
        ),
        children: [
          { index: true, element: null },
          { path: 'terminal/:sessionId', element: null },
          { path: 'env', element: sessionFirst ? <Navigate to="/" replace /> : null },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ]),
    [connectionStatus, wsService, sessionFirst],
  );

  if (isRestoringSession || (isAuthenticated && !wsService)) {
    return <ReconnectingShell />;
  }

  return <RouterProvider router={isAuthenticated ? appRouter : loginRouter} />;
}

export default App;

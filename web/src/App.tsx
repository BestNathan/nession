import { useMemo } from 'react';
import {
  createHashRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { Dashboard } from './components/Dashboard';
import { LoginPage } from './components/LoginPage';
import { WebSocketContext } from './hooks/useWebSocket';
import { useAppConnection } from './hooks/useAppConnection';

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
            <Dashboard connectionStatus={connectionStatus} />
          </WebSocketContext.Provider>
        ),
        children: [
          { index: true, element: null },
          { path: 'terminal/:sessionId', element: null },
          { path: 'env', element: null },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ]),
    [connectionStatus, wsService],
  );

  if (isRestoringSession || (isAuthenticated && !wsService)) {
    return <ReconnectingShell />;
  }

  return <RouterProvider router={isAuthenticated ? appRouter : loginRouter} />;
}

export default App;

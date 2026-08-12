import { TerminalWorkspace } from '../terminal/components/TerminalWorkspace';

export function RenderTerminal({
  handleBackToDashboard,
  handleTerminalDisconnect,
  handleTerminalError,
}: {
  handleBackToDashboard: () => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  // TerminalWorkspace reads all session state from the jotai atoms
  // (atoms/session.ts + atoms/connection.ts), so no session props are needed
  // here.
  return (
    <TerminalWorkspace
      onBack={handleBackToDashboard}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError}
    />
  );
}

import { TerminalView, type AttachedSession } from './TerminalView';

export function RenderTerminal({
  attachedSession, handleBackToDashboard, handleTerminalDisconnect, handleTerminalError,
}: {
  attachedSession: AttachedSession;
  handleBackToDashboard: () => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  return (
    <TerminalView session={attachedSession}
      onBack={handleBackToDashboard}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError} />
  );
}

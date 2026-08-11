import { TerminalView } from './TerminalView';

export function RenderTerminal({
  handleBackToDashboard,
  handleTerminalDisconnect,
  handleTerminalError,
}: {
  handleBackToDashboard: () => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  // TerminalView reads all session state from the jotai atoms (atoms/terminal.ts),
  // so no session props are needed here.
  return (
    <TerminalView
      onBack={handleBackToDashboard}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError}
    />
  );
}

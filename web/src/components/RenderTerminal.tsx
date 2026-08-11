import { TerminalView, type AttachedSession } from './TerminalView';

export function RenderTerminal({
  attachedSession, handleBackToDashboard, handleTerminalDisconnect, handleTerminalError,
}: {
  attachedSession: AttachedSession;
  handleBackToDashboard: () => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  // TerminalView now reads session state from the jotai atoms; `attachedSession`
  // is retained only for Dashboard's route view until Task 8 wires the atoms.
  void attachedSession;
  return (
    <TerminalView
      onBack={handleBackToDashboard}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError} />
  );
}

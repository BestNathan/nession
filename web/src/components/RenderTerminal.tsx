import { TerminalView, type AttachedSession } from './TerminalView';
import type { Session } from '../types';
import type { AttachChoice } from './env/AttachDialog';

export function RenderTerminal({
  attachedSession, handleBackToDashboard, handleSwitchSession, handleTerminalDisconnect, handleTerminalError,
}: {
  attachedSession: AttachedSession;
  handleBackToDashboard: () => void;
  handleSwitchSession: (session: Session, choice: AttachChoice) => void;
  handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void;
}) {
  return (
    <TerminalView session={attachedSession}
      onBack={handleBackToDashboard}
      onSwitchSession={handleSwitchSession}
      onDisconnect={handleTerminalDisconnect}
      onError={handleTerminalError} />
  );
}

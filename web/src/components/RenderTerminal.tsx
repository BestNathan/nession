import type { WebSocketService } from '../services/websocket';
import { TerminalView, type AttachedSession } from './TerminalView';

export function RenderTerminal({
  attachedSession, wsService, handleBackToDashboard, handleTerminalDisconnect, handleTerminalError,
}: { attachedSession: AttachedSession; wsService: WebSocketService;
  handleBackToDashboard: () => void; handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void; }) {
  return (
    <TerminalView session={attachedSession} wsService={wsService}
      onBack={handleBackToDashboard} onDisconnect={handleTerminalDisconnect} onError={handleTerminalError} />
  );
}

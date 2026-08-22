import type { Agent, Session } from '../types';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { DeleteAgentConfirmDialog } from './DeleteAgentConfirmDialog';
import { AttachDialog, type AttachChoice } from './env/AttachDialog';
import { SessionPreviewDialog } from './SessionPreviewDialog';

interface DashboardDialogsProps {
  // Create session
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  agents: Agent[];
  onCreated: () => void;

  // Kill session
  sessionToKill: Session | null;
  setSessionToKill: (session: Session | null) => void;
  onKilled: () => void;

  // Delete agent
  agentToDelete: Agent | null;
  setAgentToDelete: (agent: Agent | null) => void;
  onDeleted: () => void;

  // Attach dialog
  attachDialogSession: Session | null;
  setAttachDialogSession: (session: Session | null) => void;
  onConfirm: (session: Session, choice: AttachChoice) => void;

  // Preview
  previewSession: Session | null;
  setPreviewSession: (session: Session | null) => void;
}

export function DashboardDialogs({
  showCreateModal,
  setShowCreateModal,
  agents,
  onCreated,
  sessionToKill,
  setSessionToKill,
  onKilled,
  agentToDelete,
  setAgentToDelete,
  onDeleted,
  attachDialogSession,
  setAttachDialogSession,
  onConfirm,
  previewSession,
  setPreviewSession,
}: DashboardDialogsProps) {
  return (
    <>
      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        agents={agents}
        preselectedAgentId={null}
        onCreated={onCreated}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        session={sessionToKill}
        onKilled={onKilled}
      />
      <DeleteAgentConfirmDialog
        isOpen={agentToDelete !== null}
        onClose={() => setAgentToDelete(null)}
        agent={agentToDelete}
        onDeleted={onDeleted}
      />
      <AttachDialog
        isOpen={attachDialogSession !== null}
        onClose={() => setAttachDialogSession(null)}
        session={attachDialogSession}
        onConfirm={onConfirm}
      />
      <SessionPreviewDialog
        isOpen={previewSession !== null}
        onClose={() => setPreviewSession(null)}
        sessionId={previewSession?.session_id ?? ''}
        sessionName={previewSession?.session_name ?? ''}
      />
    </>
  );
}

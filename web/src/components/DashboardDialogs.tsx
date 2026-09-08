import type { Agent, Session } from '../types';
import { CreateSessionDialog } from '@/features/sessions/components/CreateSessionDialog';
import { KillConfirmDialog } from '@/features/sessions/components/KillConfirmDialog';
import { DeleteAgentConfirmDialog } from '@/features/agents/components/DeleteAgentConfirmDialog';
import { AttachDialog, type AttachChoice } from './env/AttachDialog';
import { SessionPreviewDialog } from '@/features/sessions/components/SessionPreviewDialog';

interface DashboardDialogsProps {
  // Create session
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  agents: Agent[];
  onCreated: () => void;
  preselectedAgentId?: string | null;

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
  preselectedAgentId,
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
        preselectedAgentId={preselectedAgentId ?? null}
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

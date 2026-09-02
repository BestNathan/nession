import { CreateSessionDialog } from '@/components/CreateSessionDialog';
import { KillConfirmDialog } from '@/components/KillConfirmDialog';
import { AttachDialog, type AttachChoice } from '@/components/env/AttachDialog';
import { useDashboard } from '@/hooks/useDashboard';
import type { Session } from '@/types';

export function SessionFirstDialogs({
  showCreateModal,
  setShowCreateModal,
  agents,
  handleSessionCreated,
  sessionToKill,
  setSessionToKill,
  onKilled,
  attachDialogSession,
  onAttachConfirm,
  onAttachClose,
}: {
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  agents: ReturnType<typeof useDashboard>['agents'];
  handleSessionCreated: () => void;
  sessionToKill: Session | null;
  setSessionToKill: (session: Session | null) => void;
  onKilled: () => void;
  attachDialogSession: Session | null;
  onAttachConfirm: (session: Session, choice: AttachChoice) => void;
  onAttachClose: () => void;
}) {
  return (
    <>
      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        agents={agents}
        preselectedAgentId={null}
        onCreated={handleSessionCreated}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        session={sessionToKill}
        onKilled={onKilled}
      />
      <AttachDialog
        isOpen={attachDialogSession !== null}
        onClose={onAttachClose}
        session={attachDialogSession}
        onConfirm={onAttachConfirm}
      />
    </>
  );
}

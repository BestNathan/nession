import { CreateSessionDialog } from '@/features/sessions/components/CreateSessionDialog';
import { KillConfirmDialog } from '@/features/sessions/components/KillConfirmDialog';
import { AttachDialog, type AttachChoice } from '@/features/sessions/components/AttachDialog';
import { useDashboard } from '@/app/useDashboard';
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
  attachDialogIntent,
  onAttachConfirm,
  onConfigureConfirm,
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
  attachDialogIntent: 'attach' | 'configure';
  onAttachConfirm: (session: Session, choice: AttachChoice) => void;
  onConfigureConfirm: (session: Session, choice: AttachChoice) => void;
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
        intent={attachDialogIntent}
        onClose={onAttachClose}
        session={attachDialogSession}
        onConfirm={attachDialogIntent === 'configure' ? onConfigureConfirm : onAttachConfirm}
      />
    </>
  );
}

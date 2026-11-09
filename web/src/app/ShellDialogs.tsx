import { CreateSessionDialog } from '@/product/session/components/CreateSessionDialog';
import { KillConfirmDialog } from '@/product/session/components/KillConfirmDialog';
import { AttachDialog, type AttachChoice } from '@/product/session/components/AttachDialog';
import { AppAttachSurface } from '@/app/experiences/app/AppAttachSurface';
import { AppCreateSessionSurface } from '@/app/experiences/app/AppCreateSessionSurface';
import { useDashboard } from '@/app/useDashboard';
import type { ExperienceMode } from '@/app/experienceMode';
import type { Session } from '@/types';

/**
 * The shell's Session operations, composed by Experience (#3089).
 *
 * Web keeps the centered content-capable dialogs; App opens its quick sheet
 * and full-height operation pages. The flows, state and confirmation owners
 * are the same; only the composition differs.
 */
export function ShellDialogs({
  experience,
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
  experience: ExperienceMode;
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  agents: ReturnType<typeof useDashboard>['agents'];
  /** Forwarded unchanged from `CreateSessionDialog`; see its `onCreated`. */
  handleSessionCreated: (sessionId?: string) => void;
  sessionToKill: Session | null;
  setSessionToKill: (session: Session | null) => void;
  onKilled: () => void;
  attachDialogSession: Session | null;
  attachDialogIntent: 'attach' | 'configure';
  onAttachConfirm: (session: Session, choice: AttachChoice) => void;
  onConfigureConfirm: (session: Session, choice: AttachChoice) => void;
  onAttachClose: () => void;
}) {
  const created = experience === 'app' ? (
    <AppCreateSessionSurface
      isOpen={showCreateModal}
      agents={agents}
      onClose={() => setShowCreateModal(false)}
      onCreated={handleSessionCreated}
    />
  ) : (
    <CreateSessionDialog
      isOpen={showCreateModal}
      onClose={() => setShowCreateModal(false)}
      agents={agents}
      preselectedAgentId={null}
      onCreated={handleSessionCreated}
    />
  );

  const attach = experience === 'app' ? (
    <AppAttachSurface
      isOpen={attachDialogSession !== null}
      intent={attachDialogIntent}
      session={attachDialogSession}
      agents={agents}
      onClose={onAttachClose}
      onConfirm={attachDialogIntent === 'configure' ? onConfigureConfirm : onAttachConfirm}
    />
  ) : (
    <AttachDialog
      isOpen={attachDialogSession !== null}
      intent={attachDialogIntent}
      onClose={onAttachClose}
      session={attachDialogSession}
      onConfirm={attachDialogIntent === 'configure' ? onConfigureConfirm : onAttachConfirm}
    />
  );

  return (
    <>
      {created}
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        session={sessionToKill}
        onKilled={onKilled}
      />
      {attach}
    </>
  );
}

import type { Agent, Session } from '../types';
import type { AddressProbeCache } from '../hooks/useAddressProbeCache';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AgentDetailPanel } from './AgentDetailPanel';
import { AttachDialog, type AttachChoice } from './env/AttachDialog';

interface DashboardModalsProps {
  agents: Agent[];
  selectedAgent: Agent | null;
  getHeartbeatHistory: (agentId: string) => string[];
  showCreateModal: boolean;
  sessionToKill: Session | null;
  attachDialogSession: Session | null;
  probeCache: AddressProbeCache;
  onCloseAgentDetail: () => void;
  onCloseCreateModal: () => void;
  onSessionCreated: () => void;
  onCloseKillModal: () => void;
  onSessionKilled: () => void;
  onCloseAttachDialog: () => void;
  onConfirmAttach: (session: Session, choice: AttachChoice) => void;
}

export function DashboardModals({
  agents, selectedAgent, getHeartbeatHistory,
  showCreateModal, sessionToKill, attachDialogSession, probeCache,
  onCloseAgentDetail, onCloseCreateModal, onSessionCreated,
  onCloseKillModal, onSessionKilled,
  onCloseAttachDialog, onConfirmAttach,
}: DashboardModalsProps) {
  return (
    <>
      {selectedAgent && (
        <AgentDetailPanel
          agent={selectedAgent}
          heartbeatHistory={getHeartbeatHistory(selectedAgent.agent_id)}
          onClose={onCloseAgentDetail}
        />
      )}

      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={onCloseCreateModal}
        agents={agents}
        preselectedAgentId={null}
        onCreated={onSessionCreated}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={onCloseKillModal}
        session={sessionToKill}
        onKilled={onSessionKilled}
      />
      <AttachDialog
        isOpen={attachDialogSession !== null}
        onClose={onCloseAttachDialog}
        session={attachDialogSession}
        onConfirm={onConfirmAttach}
        probeCache={probeCache}
      />
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useCreateSessionEnvCatalog,
  useProjectEnvSelection,
} from '@/product/session/hooks/useCreateSessionEnv';
import { useManagedCreateForm } from '@/product/session/hooks/useManagedCreateForm';
import { useCreateSessionSubmission } from '@/product/session/hooks/useCreateSessionSubmission';
import { useDialogReset } from '@/shared/hooks/useDialogReset';
import type { Agent, EnvFileRef } from '@/types';
import type { Project, ProjectLocation } from '@/product/project/types';
import type { CreateEnvSelectionMode } from '@/product/session/model/envSelection';

interface CreateSessionFormOptions {
  isOpen: boolean;
  agents: Agent[];
  preselectedAgentId?: string | null;
  project?: Project | null;
  onCreated: (sessionId?: string) => void;
  onClose: () => void;
}

/**
 * The create-session form state, Project runtime resolution and submit path.
 *
 * Kept out of the dialog component so the rendered form stays a description
 * of the fields. A Project Session has two explicit runtimes: an Existing
 * Location (Host) or a Managed EROFS composition (#3794). The global New
 * Session flow keeps its pre-Project behavior.
 */
export function useCreateSessionForm({
  isOpen,
  agents,
  preselectedAgentId,
  project,
  onCreated,
  onClose,
}: CreateSessionFormOptions) {
  const [agentId, setAgentId] = useState('');
  const [locationIndex, setLocationIndex] = useState(0);
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const { envFiles, envCatalogState } = useCreateSessionEnvCatalog(isOpen);
  const [selectedEnv, setSelectedEnv] = useState<EnvFileRef[]>([]);
  const [envSelectionMode, setEnvSelectionMode] =
    useState<CreateEnvSelectionMode>('inherit');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);
  const locations: ProjectLocation[] = project?.locations ?? [];
  const selectedLocation = project ? locations[locationIndex] ?? locations[0] ?? null : null;
  const selectedLocationAgent = selectedLocation
    ? agents.find((agent) => agent.agent_id === selectedLocation.agent_id)
    : undefined;
  const locationUnavailable = Boolean(project) && selectedLocationAgent?.status !== 'online';

  const { effectiveEnv, unavailableEnv } = useProjectEnvSelection({
    project,
    envFiles,
    envCatalogState,
    selectedEnv,
    envSelectionMode,
  });
  const managed = useManagedCreateForm({
    isOpen,
    project,
    onlineAgents,
    onSelectionChange: () => {
      setReviewing(false);
      setError(null);
    },
  });
  const { submit, beginReview, handleSubmit } = useCreateSessionSubmission({
    sessionName,
    agentId,
    project,
    selectedLocation,
    selectedLocationAgent,
    envSelectionMode,
    selectedEnv,
    unavailableEnv,
    reviewing,
    setReviewing,
    setError,
    setLoading,
    managed,
    onCreated,
    onClose,
  });

  const resetManaged = managed.resetManaged;
  const onlineAgentsRef = useRef(onlineAgents);
  onlineAgentsRef.current = onlineAgents;

  const resetState = useCallback(() => {
    const online = onlineAgentsRef.current;
    setAgentId(preselectedAgentId ?? (online.length > 0 ? online[0].agent_id : ''));
    setLocationIndex(0);
    setSessionName('');
    setLoading(false);
    setError(null);
    setSelectedEnv([]);
    setEnvSelectionMode('inherit');
    setReviewing(false);
    resetManaged();
  }, [preselectedAgentId, resetManaged]);
  useDialogReset(isOpen, resetState);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  return {
    submit,
    handleSubmit,
    beginReview,
    backToForm: () => {
      setReviewing(false);
      setError(null);
    },
    reviewing,
    agentId,
    setAgentId,
    locationIndex,
    setLocationIndex,
    sessionName,
    setSessionName,
    loading,
    error,
    envFiles,
    envCatalogState,
    selectedEnv,
    setSelectedEnv,
    envSelectionMode,
    setEnvSelectionMode,
    effectiveEnv,
    unavailableEnv,
    nameInputRef,
    onlineAgents,
    locations,
    selectedLocation,
    selectedLocationAgent,
    locationUnavailable,
    project,
    ...managed,
  };
}

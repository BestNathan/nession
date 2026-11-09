import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { envApi } from '@/capabilities/env';
import { sessionsApi } from '@/product/session';
import { useDialogReset } from '@/shared/hooks/useDialogReset';
import { agentDisplayName } from '@/shared/lib/format';
import type { Agent, EnvFileInfo, EnvFileRef } from '@/types';
import type { Project, ProjectLocation } from '@/product/project/types';

function validateName(name: string): string | null {
  if (!name.trim()) {return 'Session name is required';}
  if (!/^[a-zA-Z0-9_\-.]+$/.test(name.trim())) {
    return 'Only letters, digits, underscores, hyphens, and dots allowed';
  }
  return null;
}

interface CreateSessionFormOptions {
  isOpen: boolean;
  agents: Agent[];
  preselectedAgentId?: string | null;
  project?: Project | null;
  onCreated: (sessionId?: string) => void;
  onClose: () => void;
}

/**
 * The create-session form state, project/location resolution and submit path.
 *
 * Kept out of the dialog component so the rendered form stays a description of
 * the fields: the Project branch changes where Agent and directory come from,
 * not what the form is.
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
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [selectedEnv, setSelectedEnv] = useState<EnvFileRef[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);
  const locations: ProjectLocation[] = project?.locations ?? [];
  const selectedLocation = project ? locations[locationIndex] ?? locations[0] ?? null : null;
  const selectedLocationAgent = selectedLocation
    ? agents.find((agent) => agent.agent_id === selectedLocation.agent_id)
    : undefined;
  const locationUnavailable = Boolean(project) && selectedLocationAgent?.status !== 'online';

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
  }, [preselectedAgentId]);
  useDialogReset(isOpen, resetState);

  useEffect(() => {
    if (isOpen) {
      envApi
        .listEnvFiles()
        .then((resp) => setEnvFiles(resp.files))
        .catch(() => setEnvFiles([]));
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nameError = validateName(sessionName);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (project) {
      if (!selectedLocation) {
        setError('This Project has no Existing Location. Add one in Project settings.');
        return;
      }
      if (selectedLocationAgent?.status !== 'online') {
        setError(
          `Agent '${selectedLocationAgent ? agentDisplayName(selectedLocationAgent) : selectedLocation.agent_id}' is offline`,
        );
        return;
      }
    }
    if (!project && !agentId) {
      setError('Please select an agent');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = project && selectedLocation
        ? await sessionsApi.createSession(selectedLocation.agent_id, sessionName.trim(), selectedEnv, {
            workingDir: selectedLocation.path,
            projectId: project.project_id,
          })
        : await sessionsApi.createSession(agentId, sessionName.trim(), selectedEnv);
      if (result.success) {
        onCreated(result.session_id);
        onClose();
      } else {
        setError(result.error ?? 'Failed to create session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  return {
    agentId,
    setAgentId,
    locationIndex,
    setLocationIndex,
    sessionName,
    setSessionName,
    loading,
    error,
    envFiles,
    selectedEnv,
    setSelectedEnv,
    nameInputRef,
    onlineAgents,
    locations,
    selectedLocation,
    locationUnavailable,
    handleSubmit,
  };
}

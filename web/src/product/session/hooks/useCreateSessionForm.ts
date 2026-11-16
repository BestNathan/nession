import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionsApi } from '@/product/session';
import {
  createEnvRequest,
  useCreateSessionEnvCatalog,
  useProjectEnvSelection,
} from '@/product/session/hooks/useCreateSessionEnv';
import { validateCreateSession } from '@/product/session/model/createSessionValidation';
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

/** The form-event wrapper around the one submit action. */
function preventDefaultSubmit(submit: () => Promise<void>) {
  return (event: React.FormEvent) => {
    event.preventDefault();
    void submit();
  };
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
  const { envFiles, envCatalogState } = useCreateSessionEnvCatalog(isOpen);
  const [selectedEnv, setSelectedEnv] = useState<EnvFileRef[]>([]);
  /**
   * The Project branch starts on `inherit`: the Server's legacy behavior is
   * exactly what a user reading "Use Project defaults" expects. The mode is
   * page state, not copied ENV state, so switching the Project while the dialog
   * is open recomputes the effective preview from the new declaration.
   */
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
  }, [preselectedAgentId]);
  useDialogReset(isOpen, resetState);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const { effectiveEnv, unavailableEnv } = useProjectEnvSelection({
    project,
    envFiles,
    envCatalogState,
    selectedEnv,
    envSelectionMode,
  });

  /**
   * The one create action. It is exposed without a form-event dependency so a
   * surface whose anchored CTA lives outside its `<form>` (the App operation
   * page, #3089) runs the same validation and submission.
   */
  const submit = async () => {
    const invalid = validateCreateSession({
      sessionName,
      agentId,
      project,
      selectedLocation,
      selectedLocationAgent,
      envSelectionMode,
      selectedEnv,
      unavailableEnv,
    });
    if (invalid) {
      setError(invalid);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const envRequest = createEnvRequest(project, envSelectionMode, selectedEnv);
      const result = project && selectedLocation
        ? await sessionsApi.createSession(
            selectedLocation.agent_id,
            sessionName.trim(),
            envRequest.files,
            {
              workingDir: selectedLocation.path,
              projectId: project.project_id,
              envSelectionMode: envRequest.envSelectionMode,
            },
          )
        : await sessionsApi.createSession(agentId, sessionName.trim(), envRequest.files);
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

  const handleSubmit = preventDefaultSubmit(submit);

  return {
    submit,
    handleSubmit,
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
    locationUnavailable,
  };
}

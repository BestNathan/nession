import type { FormEvent } from 'react';
import { sessionsApi } from '@/product/session';
import { createEnvRequest } from '@/product/session/hooks/useCreateSessionEnv';
import { validateCreateSession } from '@/product/session/model/createSessionValidation';
import {
  managedCreateRequest,
  validateManagedCreate,
} from '@/product/session/model/managedCreate';
import type { Agent, EnvFileRef } from '@/types';
import type { Project, ProjectLocation } from '@/product/project/types';
import type { CreateEnvSelectionMode } from '@/product/session/model/envSelection';
import type { useManagedCreateForm } from './useManagedCreateForm';

type ManagedState = ReturnType<typeof useManagedCreateForm>;
type ManagedSelection = Pick<
  ManagedState,
  | 'runtimeMode'
  | 'managedAgentId'
  | 'managedAgent'
  | 'baseDigest'
  | 'toolchainDigests'
  | 'managedImages'
>;

interface SelectionInput {
  sessionName: string;
  agentId: string;
  project?: Project | null;
  selectedLocation: ProjectLocation | null;
  selectedLocationAgent?: Agent;
  envSelectionMode: CreateEnvSelectionMode;
  selectedEnv: EnvFileRef[];
  unavailableEnv: EnvFileRef[];
  managed: ManagedSelection;
}

/** The one validation path for the current Project runtime choice. */
function validateSelection({
  sessionName,
  agentId,
  project,
  selectedLocation,
  selectedLocationAgent,
  envSelectionMode,
  selectedEnv,
  unavailableEnv,
  managed,
}: SelectionInput): string | null {
  if (project && managed.runtimeMode === 'managed') {
    return validateManagedCreate({
      sessionName,
      project,
      agent: managed.managedAgent,
      baseDigest: managed.baseDigest,
      toolchains: managed.toolchainDigests,
      projectSource: managed.managedImages.projectSource,
      projectSourceError: managed.managedImages.projectSourceError,
      envSelectionMode,
      selectedEnv,
      unavailableEnv,
    });
  }
  return validateCreateSession({
    sessionName,
    agentId,
    project,
    selectedLocation,
    selectedLocationAgent,
    envSelectionMode,
    selectedEnv,
    unavailableEnv,
  });
}

/** Send the request through the one create API. Never retries as Native. */
async function sendCreate({
  sessionName,
  agentId,
  project,
  selectedLocation,
  envSelectionMode,
  selectedEnv,
  managed,
}: SelectionInput) {
  const envRequest = createEnvRequest(project, envSelectionMode, selectedEnv);
  if (project && managed.runtimeMode === 'managed') {
    return sessionsApi.createSession(
      managed.managedAgentId,
      sessionName.trim(),
      envRequest.files,
      {
        projectId: project.project_id,
        envSelectionMode: envRequest.envSelectionMode,
        managed: managedCreateRequest(managed.baseDigest, managed.toolchainDigests),
      },
    );
  }
  if (project && selectedLocation) {
    return sessionsApi.createSession(
      selectedLocation.agent_id,
      sessionName.trim(),
      envRequest.files,
      {
        workingDir: selectedLocation.path,
        projectId: project.project_id,
        envSelectionMode: envRequest.envSelectionMode,
      },
    );
  }
  return sessionsApi.createSession(agentId, sessionName.trim(), envRequest.files);
}

/**
 * The one Project/global create validation and submission path (#3794).
 *
 * `submit` is exposed without a form-event dependency so a surface whose
 * anchored CTA lives outside its `<form>` (the App operation page, #3089)
 * runs the same review and create. A Project create first opens its reviewed
 * snapshot; only a second explicit Create sends the request. A Managed
 * refusal is surfaced as an error and never retried as Native.
 */
export function useCreateSessionSubmission(
  input: SelectionInput & {
    reviewing: boolean;
    setReviewing: (reviewing: boolean) => void;
    setError: (error: string | null) => void;
    setLoading: (loading: boolean) => void;
    onCreated: (sessionId?: string) => void;
    onClose: () => void;
  },
) {
  const {
    reviewing,
    setReviewing,
    setError,
    setLoading,
    onCreated,
    onClose,
  } = input;

  const beginReview = () => {
    if (!input.project) {
      return;
    }
    const invalid = validateSelection(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setReviewing(true);
  };

  const submit = async () => {
    if (input.project && input.managed.runtimeMode === 'managed' && !reviewing) {
      beginReview();
      return;
    }
    const invalid = validateSelection(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await sendCreate(input);
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

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return { submit, beginReview, handleSubmit };
}

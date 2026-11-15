import { agentDisplayName } from '@/shared/lib/format';
import type { Agent, EnvFileRef } from '@/types';
import type { Project, ProjectLocation } from '@/product/project/types';
import type { CreateEnvSelectionMode } from './envSelection';

/** Session names are tmux names: letters, digits, `_`, `-` and `.`. */
export function validateSessionName(name: string): string | null {
  if (!name.trim()) {
    return 'Session name is required';
  }
  if (!/^[a-zA-Z0-9_\-.]+$/.test(name.trim())) {
    return 'Only letters, digits, underscores, hyphens, and dots allowed';
  }
  return null;
}

/** The pre-submit ENV validation for a Project create. */
export function validateCreateEnvSelection({
  project,
  envSelectionMode,
  selectedEnv,
  unavailableEnv,
}: {
  project?: Project | null;
  envSelectionMode: CreateEnvSelectionMode;
  selectedEnv: EnvFileRef[];
  unavailableEnv: EnvFileRef[];
}): string | null {
  if (!project) {
    return null;
  }
  if (envSelectionMode === 'custom' && selectedEnv.length === 0) {
    return 'Select at least one ENV file, or choose No environment.';
  }
  if (unavailableEnv.length > 0) {
    return `Cannot create Session: ${unavailableEnv
      .map((ref) => ref.name)
      .join(', ')} unavailable. Resolve the Project default or choose another environment.`;
  }
  return null;
}

/**
 * The create surface's one validation path, shared by the Web dialog and the
 * App operation page. The Server remains the authority; this only turns the
 * form's known blockers into a message before a request is sent.
 */
export function validateCreateSession({
  sessionName,
  agentId,
  project,
  selectedLocation,
  selectedLocationAgent,
  envSelectionMode,
  selectedEnv,
  unavailableEnv,
}: {
  sessionName: string;
  agentId: string;
  project?: Project | null;
  selectedLocation: ProjectLocation | null;
  selectedLocationAgent?: Agent;
  envSelectionMode: CreateEnvSelectionMode;
  selectedEnv: EnvFileRef[];
  unavailableEnv: EnvFileRef[];
}): string | null {
  const nameError = validateSessionName(sessionName);
  if (nameError) {
    return nameError;
  }
  if (project) {
    if (!selectedLocation) {
      return 'This Project has no Existing Location. Add one in Project settings.';
    }
    if (selectedLocationAgent?.status !== 'online') {
      return `Agent '${
        selectedLocationAgent
          ? agentDisplayName(selectedLocationAgent)
          : selectedLocation.agent_id
      }' is offline`;
    }
  } else if (!agentId) {
    return 'Please select an agent';
  }
  return validateCreateEnvSelection({
    project,
    envSelectionMode,
    selectedEnv,
    unavailableEnv,
  });
}

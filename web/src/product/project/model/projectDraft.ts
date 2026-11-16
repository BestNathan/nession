import type { ProjectUpdatePayload } from '@/generated/protocol/core/server-project-update/v1';
import type { Project, ProjectDraft, ProjectSessionDefaults } from '@/product/project/types';

export function emptyProjectDraft(): ProjectDraft {
  return { name: '', locations: [], envProfileIds: [] };
}

/** Client-side preflight; the Server's canonical validation remains authoritative. */
export function validateProjectDraft(draft: ProjectDraft): string | null {
  if (!draft.name.trim()) {
    return 'Project name is required';
  }
  const url = draft.source?.repository_url.trim() ?? '';
  const ref = draft.source?.ref.trim() ?? '';
  if (url && !ref) {
    return 'A Git source needs a branch or full commit SHA';
  }
  if (!url && ref) {
    return 'A Git ref needs a repository URL';
  }
  for (const location of draft.locations) {
    if (!location.agent_id) {
      return 'Each Existing Location needs an Agent';
    }
    if (!location.path.trim()) {
      return 'Each Existing Location needs a directory';
    }
    if (!location.path.trim().startsWith('/') && !/^[A-Za-z]:[\\/]/.test(location.path.trim())) {
      return 'Existing Location directories must be absolute';
    }
  }
  const digest = draft.image_digest?.trim() ?? '';
  if (digest && !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return 'Image digest must be sha256:<64 lowercase hex>';
  }
  return null;
}

/** Only the mutable declaration; the Server keeps identity and timestamps. */
export function draftOf(project: Project): ProjectDraft {
  return {
    name: project.name,
    description: project.description ?? undefined,
    source: project.source ?? undefined,
    locations: project.locations,
    envProfileIds: project.session_defaults?.env_profile_ids ?? [],
    image_digest: project.image_digest ?? undefined,
  };
}

export function normalizedLocations(draft: ProjectDraft) {
  return draft.locations.map((location) => ({
    agent_id: location.agent_id.trim(),
    path: location.path.trim(),
  }));
}

export function hasSource(draft: ProjectDraft): boolean {
  return Boolean(draft.source?.repository_url.trim());
}

/** The whole replacement the update unit requires. */
export function updatePayload(project: Project, draft: ProjectDraft): ProjectUpdatePayload {
  return {
    project_id: project.project_id,
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    source: hasSource(draft)
      ? {
          repository_url: draft.source?.repository_url.trim() ?? '',
          ref: draft.source?.ref.trim() ?? '',
        }
      : null,
    locations: normalizedLocations(draft),
    session_defaults: sessionDefaultsOf(project, draft),
    image_digest: draft.image_digest?.trim() || null,
  };
}

/**
 * The Session-defaults replacement for an update (#3649).
 *
 * Only ENV references are edited here. `shell` and `sandbox_policy_ref` are
 * preserved because the update unit replaces the whole declaration, and a
 * Project that had no defaults still gains an object when the user explicitly
 * saves an empty ENV list — the empty list is a declaration, not an absence.
 */
export function sessionDefaultsOf(
  project: Project,
  draft: ProjectDraft,
): ProjectSessionDefaults | null {
  const existing = project.session_defaults;
  if (!existing && draft.envProfileIds.length === 0) {
    return null;
  }
  return {
    shell: existing?.shell ?? null,
    env_profile_ids: draft.envProfileIds,
    sandbox_policy_ref: existing?.sandbox_policy_ref ?? null,
  };
}

/** The create payload's optional defaults: present when the user selected any. */
export function createSessionDefaults(
  draft: ProjectDraft,
): ProjectSessionDefaults | undefined {
  return draft.envProfileIds.length > 0
    ? { env_profile_ids: draft.envProfileIds }
    : undefined;
}

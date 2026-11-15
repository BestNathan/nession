import { useCallback, useEffect, useState } from 'react';
import { envApi } from '@/capabilities/env';
import { projectsApi } from '@/product/project';
import {
  createSessionDefaults,
  draftOf,
  emptyProjectDraft,
  hasSource,
  normalizedLocations,
  updatePayload,
  validateProjectDraft,
} from '@/product/project/model/projectDraft';
import { useDialogReset } from '@/shared/hooks/useDialogReset';
import type { EnvFileInfo } from '@/types';
import type { Project, ProjectDraft } from '@/product/project/types';

/**
 * The Project create/settings form owner (#3089).
 *
 * The Web dialog and the App operation page render different compositions of
 * the same declaration edit; validation, payload shape and persistence stay
 * here so the two experiences cannot submit different Projects.
 */
export function useProjectDraftForm({
  kind,
  isOpen,
  project,
  onChanged,
  onSaved,
  onClose,
}: {
  kind: 'create' | 'settings';
  isOpen: boolean;
  project?: Project | null;
  onChanged: () => Promise<void> | void;
  onSaved: (project: Project) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ProjectDraft>(emptyProjectDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [envFilesLoading, setEnvFilesLoading] = useState(false);

  // The Project form names Server ENV files, so it needs the same global
  // catalog the create-time chooser uses. Read on open so a file created in
  // the Environment capability is visible without remounting the shell.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let active = true;
    setEnvFilesLoading(true);
    envApi
      .listEnvFiles()
      .then((response) => {
        if (active) { setEnvFiles(response.files); }
      })
      .catch(() => {
        if (active) { setEnvFiles([]); }
      })
      .finally(() => {
        if (active) { setEnvFilesLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  const reset = useCallback(() => {
    setDraft(kind === 'settings' && project ? draftOf(project) : emptyProjectDraft());
    setBusy(false);
    setError(null);
  }, [kind, project]);
  useDialogReset(isOpen, reset);

  const submit = useCallback(async () => {
    const invalid = validateProjectDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved =
        kind === 'create'
          ? await projectsApi.createProject({
              name: draft.name.trim(),
              description: draft.description?.trim() || undefined,
              source: hasSource(draft)
                ? {
                    repository_url: draft.source?.repository_url.trim() ?? '',
                    ref: draft.source?.ref.trim() ?? '',
                  }
                : undefined,
              locations: normalizedLocations(draft),
              session_defaults: createSessionDefaults(draft),
              image_digest: draft.image_digest?.trim() || undefined,
            })
          : await projectsApi.updateProject(updatePayload(project as Project, draft));
      await onChanged();
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project could not be saved');
    } finally {
      setBusy(false);
    }
  }, [draft, kind, project, onChanged, onSaved, onClose]);

  return { draft, setDraft, busy, error, submit, envFiles, envFilesLoading };
}

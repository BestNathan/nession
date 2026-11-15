import { useEffect, useMemo, useState } from 'react';
import { envApi, refKey } from '@/capabilities/env';
import type { EnvFileInfo, EnvFileRef } from '@/types';
import type { Project } from '@/product/project/types';
import type {
  CreateEnvOrigin,
  CreateEnvSelectionMode,
} from '@/product/session/model/envSelection';

export type EnvCatalogState = 'loading' | 'ready' | 'error';

/** The ENV catalog the create surface needs, read when the surface opens. */
export function useCreateSessionEnvCatalog(isOpen: boolean): {
  envFiles: EnvFileInfo[];
  envCatalogState: EnvCatalogState;
} {
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [envCatalogState, setEnvCatalogState] = useState<EnvCatalogState>('loading');

  useEffect(() => {
    if (!isOpen) {
      setEnvFiles([]);
      setEnvCatalogState('loading');
      return;
    }
    envApi
      .listEnvFiles()
      .then((resp) => {
        setEnvFiles(resp.files);
        setEnvCatalogState('ready');
      })
      .catch(() => {
        setEnvFiles([]);
        setEnvCatalogState('error');
      });
  }, [isOpen]);

  return { envFiles, envCatalogState };
}

/**
 * The Project branch's effective selection (#3649).
 *
 * `inherit` reads the Project declaration directly instead of copying it into
 * form state, so a Project change while the create surface is open recomputes
 * the preview. Missing references are reported only once the catalog answered:
 * a failed catalog read is unknown, not "everything is missing".
 */
export function useProjectEnvSelection({
  project,
  envFiles,
  envCatalogState,
  selectedEnv,
  envSelectionMode,
}: {
  project?: Project | null;
  envFiles: EnvFileInfo[];
  envCatalogState: EnvCatalogState;
  selectedEnv: EnvFileRef[];
  envSelectionMode: CreateEnvSelectionMode;
}): {
  projectDefaultEnv: EnvFileRef[];
  effectiveEnv: { refs: EnvFileRef[]; origin: CreateEnvOrigin };
  unavailableEnv: EnvFileRef[];
} {
  const projectDefaultEnv = useMemo<EnvFileRef[]>(
    () =>
      project?.session_defaults?.env_profile_ids.map((name) => ({
        name,
        source: 'server' as const,
      })) ?? [],
    [project?.session_defaults?.env_profile_ids],
  );

  const effectiveEnv = useMemo<{ refs: EnvFileRef[]; origin: CreateEnvOrigin }>(() => {
    if (!project) {
      return { refs: selectedEnv, origin: 'explicit' };
    }
    if (envSelectionMode === 'inherit') {
      return { refs: projectDefaultEnv, origin: 'project' };
    }
    if (envSelectionMode === 'custom') {
      return { refs: selectedEnv, origin: 'custom' };
    }
    return { refs: [], origin: 'none' };
  }, [project, envSelectionMode, projectDefaultEnv, selectedEnv]);

  const unavailableEnv = useMemo(
    () =>
      envCatalogState === 'ready'
        ? effectiveEnv.refs.filter(
            (ref) => !envFiles.some((file) => refKey(file) === refKey(ref)),
          )
        : [],
    [envCatalogState, effectiveEnv.refs, envFiles],
  );

  return { projectDefaultEnv, effectiveEnv, unavailableEnv };
}

/**
 * The wire selection for the Project branch.
 *
 * `custom` and `none` both send `replace`; only `none` is the empty list. The
 * ordinary non-Project create sends no mode and keeps its legacy behavior.
 */
export function createEnvRequest(
  project: Project | null | undefined,
  envSelectionMode: CreateEnvSelectionMode,
  selectedEnv: EnvFileRef[],
): { files: EnvFileRef[]; envSelectionMode?: 'inherit' | 'replace' } {
  if (!project) {
    return { files: selectedEnv };
  }
  return {
    files: envSelectionMode === 'custom' ? selectedEnv : [],
    envSelectionMode: envSelectionMode === 'inherit' ? 'inherit' : 'replace',
  };
}

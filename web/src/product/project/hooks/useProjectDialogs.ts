import { useCallback, useState } from 'react';
import type { Project } from '@/product/project/types';

/** Which Project dialog is open, and against which Project. */
export interface ProjectDialogState {
  createOpen: boolean;
  renameTarget: Project | null;
  settingsTarget: Project | null;
  deleteTarget: Project | null;
  sessionProject: Project | null;
  openCreate: () => void;
  closeCreate: () => void;
  openRename: (project: Project) => void;
  closeRename: () => void;
  openSettings: (project: Project) => void;
  closeSettings: () => void;
  openDelete: (project: Project) => void;
  closeDelete: () => void;
  openCreateSession: (project: Project) => void;
  closeCreateSession: () => void;
}

export function useProjectDialogs(): ProjectDialogState {
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [sessionProject, setSessionProject] = useState<Project | null>(null);

  const openCreate = useCallback(() => setCreateOpen(true), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const openRename = useCallback((project: Project) => setRenameTarget(project), []);
  const closeRename = useCallback(() => setRenameTarget(null), []);
  const openSettings = useCallback((project: Project) => setSettingsTarget(project), []);
  const closeSettings = useCallback(() => setSettingsTarget(null), []);
  const openDelete = useCallback((project: Project) => setDeleteTarget(project), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);
  const openCreateSession = useCallback((project: Project) => setSessionProject(project), []);
  const closeCreateSession = useCallback(() => setSessionProject(null), []);

  return {
    createOpen,
    renameTarget,
    settingsTarget,
    deleteTarget,
    sessionProject,
    openCreate,
    closeCreate,
    openRename,
    closeRename,
    openSettings,
    closeSettings,
    openDelete,
    closeDelete,
    openCreateSession,
    closeCreateSession,
  };
}

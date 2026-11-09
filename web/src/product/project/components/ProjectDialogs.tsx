import { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CreateSessionDialog } from '@/product/session/components/CreateSessionDialog';
import { projectsApi } from '@/product/project';
import { updatePayload, draftOf } from '@/product/project/model/projectDraft';
import { useProjectDraftForm } from '@/product/project/hooks/useProjectDraftForm';
import { ProjectFormFields } from './ProjectFormFields';
import { useDialogReset } from '@/shared/hooks/useDialogReset';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Agent } from '@/types';
import type { Project } from '@/product/project/types';
import type { ProjectDialogState } from '@/product/project/hooks/useProjectDialogs';


function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className={cn('text-destructive', chromeSansRole('body'))} data-testid="project-dialog-error">
      {error}
    </p>
  ) : null;
}

export function CreateProjectDialog({
  isOpen,
  onClose,
  agents,
  onCreated,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  onCreated: (project: Project) => void;
  onChanged: () => Promise<void> | void;
}) {
  const form = useProjectDraftForm({
    kind: 'create',
    isOpen,
    onChanged,
    onSaved: onCreated,
    onClose,
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[45rem]" data-testid="create-project-dialog">
        <DialogHeader className="sticky top-0 z-10 -mx-4 bg-popover px-4 pb-2">
          <DialogTitle>Create Project</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit();
          }}
        >
          <ProjectFormFields
            draft={form.draft}
            onChange={form.setDraft}
            agents={agents}
            disabled={form.busy}
            idPrefix="project-create"
          />
          <ErrorText error={form.error} />
          <DialogFooter sticky>
            <Button type="button" variant="outline" onClick={() => onClose()} disabled={form.busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.busy} data-testid="project-create-submit">
              {form.busy ? 'Creating…' : 'Create Project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameProjectDialog({
  project,
  onClose,
  onChanged,
}: {
  project: Project | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName(project?.name ?? '');
    setBusy(false);
    setError(null);
  }, [project]);
  useDialogReset(Boolean(project), reset);

  if (!project) {
    return null;
  }

  const submit = async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await projectsApi.updateProject({
        ...updatePayload(project, { ...draftOf(project), name }),
      });
      await onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename Project</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-rename-name">Name</Label>
            <Input
              id="project-rename-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              autoComplete="off"
              autoFocus
            />
          </div>
          <ErrorText error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose()} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} data-testid="project-rename-submit">
              {busy ? 'Saving…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectSettingsDialog({
  project,
  agents,
  onClose,
  onChanged,
}: {
  project: Project | null;
  agents: Agent[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const form = useProjectDraftForm({
    kind: 'settings',
    isOpen: Boolean(project),
    project,
    onChanged,
    onSaved: () => undefined,
    onClose,
  });

  if (!project) {
    return null;
  }

  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[45rem]" data-testid="project-settings-dialog">
        <DialogHeader className="sticky top-0 z-10 -mx-4 bg-popover px-4 pb-2">
          <DialogTitle>Project settings</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit();
          }}
        >
          <ProjectFormFields
            draft={form.draft}
            onChange={form.setDraft}
            agents={agents}
            disabled={form.busy}
            idPrefix="project-settings"
          />
          <ErrorText error={form.error} />
          <DialogFooter sticky>
            <Button type="button" variant="outline" onClick={() => onClose()} disabled={form.busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.busy} data-testid="project-settings-submit">
              {form.busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectDeleteDialog({
  project,
  onClose,
  onDeleted,
  onChanged,
}: {
  project: Project | null;
  onClose: () => void;
  onDeleted: (project: Project) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setBusy(false);
    setError(null);
  }, []);
  useDialogReset(Boolean(project), reset);

  if (!project) {
    return null;
  }

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await projectsApi.deleteProject(project.project_id);
      await onChanged();
      onDeleted(project);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project could not be deleted');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Project “{project.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Only the Project declaration is removed. Sessions, user-owned Existing
            Location directories, and globally shared image content are not deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorText error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void remove()}
            disabled={busy}
            data-testid="project-delete-confirm"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? 'Deleting…' : 'Delete Project'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** All Project dialogs, composed once by the shell or a fixture route. */
export function ProjectDialogs({
  dialogs,
  agents,
  onChanged,
  onCreated,
  onDeleted,
  onSessionCreated,
}: {
  dialogs: ProjectDialogState;
  agents: Agent[];
  onChanged: () => Promise<void> | void;
  onCreated: (project: Project) => void;
  onDeleted: (project: Project) => void;
  onSessionCreated: (sessionId?: string) => void;
}) {
  return (
    <>
      <CreateProjectDialog
        isOpen={dialogs.createOpen}
        onClose={dialogs.closeCreate}
        agents={agents}
        onCreated={onCreated}
        onChanged={onChanged}
      />
      <RenameProjectDialog
        project={dialogs.renameTarget}
        onClose={dialogs.closeRename}
        onChanged={onChanged}
      />
      <ProjectSettingsDialog
        project={dialogs.settingsTarget}
        agents={agents}
        onClose={dialogs.closeSettings}
        onChanged={onChanged}
      />
      <ProjectDeleteDialog
        project={dialogs.deleteTarget}
        onClose={dialogs.closeDelete}
        onDeleted={onDeleted}
        onChanged={onChanged}
      />
      <CreateSessionDialog
        isOpen={Boolean(dialogs.sessionProject)}
        project={dialogs.sessionProject}
        onClose={dialogs.closeCreateSession}
        agents={agents}
        onCreated={(sessionId) => {
          dialogs.closeCreateSession();
          onSessionCreated(sessionId);
        }}
      />
    </>
  );
}

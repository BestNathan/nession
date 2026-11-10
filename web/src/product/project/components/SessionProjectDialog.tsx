import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { Session } from '@/types';
import type { Project } from '@/product/project/types';

const NONE = '__none__';

/**
 * Explicit Session→Project association (#3082 SC-03/SC-06).
 *
 * A membership edit only. The copy says so because the server guarantees it:
 * saving here never moves cwd, rewrites ENV, remounts an EROFS image or
 * restarts the tmux Session.
 */
export function SessionProjectDialog({
  session,
  projects,
  busy,
  error,
  onSave,
  onClose,
}: {
  session: Session | null;
  projects: Project[];
  busy: boolean;
  error: string | null;
  onSave: (projectId: string | null) => void;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState(NONE);

  useEffect(() => {
    setSelection(session?.project_id ?? NONE);
  }, [session?.session_id, session?.project_id]);

  const projectId = selection === NONE ? null : selection;
  const current = projects.find((project) => project.project_id === session?.project_id);
  const selected = projects.find((project) => project.project_id === projectId);

  return (
    <Dialog open={session !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-testid="session-project-dialog"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Project membership</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
            Session {session?.session_name ?? ''} ·{' '}
            {current ? `currently ${current.name}` : 'currently unassociated'}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="session-project-select">Project</Label>
            <Select
              value={selection}
              onValueChange={(value) => {
                if (value) {
                  setSelection(value);
                }
              }}
              disabled={busy}
            >
              <SelectTrigger
                id="session-project-select"
                data-testid="session-project-trigger"
                className="w-full"
              >
                <span className="truncate" data-testid="session-project-selected">
                  {projectId === null
                    ? 'No Project'
                    : (selected?.name ?? 'Project unavailable')}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No Project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.project_id} value={project.project_id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Changing membership does not alter the Session&apos;s cwd, ENV, mounts or running
            process.
          </p>
          {error ? (
            <p data-testid="session-project-error" className={cn('text-destructive', chromeSansRole('body'))}>
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onClose()} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="session-project-save"
            onClick={() => onSave(projectId)}
            disabled={busy || projectId === (session?.project_id ?? null)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

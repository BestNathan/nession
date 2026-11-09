import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { CapabilityState } from '@/product/capability';
import type { SessionProjectContext } from '@/product/project/types';

/** Project's Terminal Peek: concise identity, source and membership actions. */
export function ProjectPeek({
  context,
  state,
}: {
  context: SessionProjectContext | undefined;
  state: CapabilityState;
}) {
  if (!context) {
    return (
      <p data-testid="project-peek" className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        Project context is unavailable.
      </p>
    );
  }
  const focused = context.focusedProject;
  return (
    <div data-testid="project-peek" className="flex flex-col gap-2">
      {focused.status === 'ready' ? (
        <>
          <strong data-testid="project-peek-name" className={chromeSansRole('primary')}>
            {focused.project.name}
          </strong>
          <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
            Session membership · explicit link
          </p>
          {focused.project.source ? (
            <p className={cn('break-all', chromeMonoRole('metadata'))}>
              {focused.project.source.repository_url} · {focused.project.source.ref}
            </p>
          ) : (
            <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
              No Git Source configured.
            </p>
          )}
        </>
      ) : focused.status === 'loading' ? (
        <p data-testid="project-peek-loading" className={chromeSansRole('secondary')}>
          Loading Project…
        </p>
      ) : (
        <p data-testid="project-peek-unavailable" className={cn('text-destructive', chromeSansRole('secondary'))}>
          This Project is no longer available. The Session is unchanged.
        </p>
      )}
      {state === 'active' ? (
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Project capability is open.
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="project-peek-manage"
        onClick={() => context.onAssociate()}
      >
        {focused.status === 'ready' ? 'Change / remove association' : 'Manage association'}
      </Button>
    </div>
  );
}

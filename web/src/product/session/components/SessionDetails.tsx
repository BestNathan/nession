import { formatRelativeTime } from '@/shared/lib/format';
import { ConnectionStatus } from '@/product/session/patterns/ConnectionStatus';
import type { DomainState } from '@/product/session/model/domainState';
import type { Session } from '@/types';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';

export interface SessionDetailsProps {
  session: Session;
  state: DomainState;
}

export function SessionDetails({ session, state }: SessionDetailsProps) {
  return (
    <div data-testid="session-details" className="flex flex-col gap-4 p-4">
      <div>
        <h2 className={chromeSansRole('primary')}>{session.session_name}</h2>
        <p className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>{session.session_id}</p>
      </div>

      <ConnectionStatus state={state} />

      <dl className={cn('grid gap-2', chromeSansRole('body'))}>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Windows</dt>
          <dd>{session.window_count}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Last activity</dt>
          <dd>{formatRelativeTime(session.last_activity)}</dd>
        </div>
      </dl>
    </div>
  );
}

import { formatRelativeTime } from '@/lib/format';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import type { DomainState } from '@/session-first/domainState';
import type { Session } from '@/types';

export interface SessionDetailsProps {
  session: Session;
  state: DomainState;
}

export function SessionDetails({ session, state }: SessionDetailsProps) {
  return (
    <div data-testid="session-details" className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold">{session.session_name}</h2>
        <p className="text-sm text-muted-foreground">{session.session_id}</p>
      </div>

      <ConnectionStatus state={state} />

      <dl className="grid gap-2 text-sm">
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

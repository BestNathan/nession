import { formatAbsoluteTime, formatRelativeTime } from '@/shared/lib/format';
import { ConnectionStatus } from '@/product/session/patterns/ConnectionStatus';
import type { DomainState } from '@/product/session/model/domainState';
import type { Session } from '@/types';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { useSessionMetadata } from '@/product/session/hooks/useSessionMetadata';
import { metadataDisplayTitle } from '@/product/session/model/sessionMetadata';
import { SessionMetadataSection } from '@/product/session/components/SessionMetadataSection';

export interface SessionDetailsProps {
  session: Session;
  state: DomainState;
  /** The row menu's Edit details action opens the editor directly. */
  initialEditing?: boolean;
}

/**
 * The Session Workspace view (#2789).
 *
 * Runtime facts (identity, connection, windows, activity) come from the
 * Session DTO and stay read-only. The user-owned work context — title,
 * description, tags — is edited in `SessionMetadataSection`, which saves
 * through the Agent-owned metadata store. The tmux name and `session_id` are
 * never part of the edit: the title is a display alias.
 */
export function SessionDetails({ session, state, initialEditing = false }: SessionDetailsProps) {
  const entry = useSessionMetadata(session.session_id);

  return (
    <div data-testid="session-details" className="flex flex-col gap-4 p-4">
      <div>
        <h2 data-testid="session-title" className={chromeSansRole('primary')}>
          {metadataDisplayTitle(entry.metadata, session.session_name)}
        </h2>
        <p className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
          {session.session_id}
        </p>
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
        {entry.metadata?.created_at ? (
          // Only a recorded creation time is shown; last activity is never
          // promoted into an invented creation time.
          <div className="flex gap-2" data-testid="session-metadata-created">
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatAbsoluteTime(new Date(entry.metadata.created_at * 1000).toISOString())}</dd>
          </div>
        ) : null}
      </dl>

      <SessionMetadataSection
        session={session}
        entry={entry}
        initialEditing={initialEditing}
        editingDisabled={state.agent.channel !== 'online'}
      />
    </div>
  );
}

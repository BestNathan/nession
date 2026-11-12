import { formatAbsoluteTime, formatRelativeTime } from '@/shared/lib/format';
import { ConnectionStatus } from '@/product/session/patterns/ConnectionStatus';
import type { DomainState } from '@/product/session/model/domainState';
import type { Session } from '@/types';
import {
  DetailFact,
  DetailFacts,
  DetailHeader,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';
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
    <DetailSurface data-testid="session-details" className="p-4">
      <DetailHeader
        level="h2"
        title={metadataDisplayTitle(entry.metadata, session.session_name)}
        titleTestId="session-title"
        meta={<span className={chromeMonoRole('metadata')}>{session.session_id}</span>}
      />

      <ConnectionStatus state={state} />

      <DetailSection title="Runtime" level="h3">
        <DetailFacts className="gap-1.5">
          <DetailFact label="Windows" inline>
            {session.window_count}
          </DetailFact>
          <DetailFact label="Last activity" inline>
            {formatRelativeTime(session.last_activity)}
          </DetailFact>
          {entry.metadata?.created_at ? (
            <DetailFact label="Created" inline testId="session-metadata-created">
              {formatAbsoluteTime(new Date(entry.metadata.created_at * 1000).toISOString())}
            </DetailFact>
          ) : null}
        </DetailFacts>
      </DetailSection>

      <SessionMetadataSection
        session={session}
        entry={entry}
        initialEditing={initialEditing}
        editingDisabled={state.agent.channel !== 'online'}
      />
    </DetailSurface>
  );
}

import { Fragment, type ReactNode } from 'react';
import { SearchX } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { agentDisplayName } from '@/shared/lib/format';
import { mapDomainState } from '@/product/session/model/domainState';
import { SessionItem } from '@/product/session/patterns/SessionItem';
import type { Agent, Session } from '@/types';

/**
 * A named stretch of rows, with the caller's own label above them.
 *
 * `header` is a node rather than a string on purpose. The label's element, its
 * role and its type class are the caller's decisions — the App's history labels
 * use the App type scale, and `--typography-metadata-size` resolves to *Web's*
 * value at `:root`, so a class literal in this shared file would be a latent
 * Web-density bug rather than a visible one.
 */
export interface SessionGroup {
  key: string;
  header: ReactNode;
  sessions: Session[];
}

export interface SessionListProps {
  sessions: Session[];
  agents: Agent[];
  staleAgentIds: Iterable<string>;
  selectedId: string | null;
  clientSessionId: string;
  attachInFlightId?: string | null;
  attachFailedId?: string | null;
  loading?: boolean;
  isSearchActive?: boolean;
  onSelect: (session: Session) => void;
  onConfigure?: (session: Session) => void;
  onKill?: (session: Session) => void;
  /**
   * Rows split into labelled stretches. Absent renders `sessions` as one flat
   * list — today's behaviour, and Web's.
   *
   * `sessions` stays the source of truth for the empty case: a caller passes
   * either groups or a session array, and `groups` is read only once there are
   * rows to group.
   */
  groups?: SessionGroup[];
  /** Forwarded to every row. See `SessionItemProps['showRecency']`. */
  showRowRecency?: boolean;
  /**
   * Rendered after the last row, inside the scroll area.
   *
   * For a secondary navigation entry that belongs *below* history rather than
   * in the chrome: inside the scroll area it is "below" literally, it costs the
   * rows nothing, and anything it expands into is the container's problem
   * rather than a second flex region competing with the list's floor (#1057).
   */
  footer?: ReactNode;
}

export function SessionList({
  sessions,
  agents,
  staleAgentIds,
  selectedId,
  clientSessionId,
  attachInFlightId = null,
  attachFailedId = null,
  loading = false,
  isSearchActive = false,
  onSelect,
  onConfigure,
  onKill,
  groups,
  showRowRecency = true,
  footer,
}: SessionListProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    );
  }

  if (sessions.length === 0) {
    if (isSearchActive) {
      return (
        <div className="flex flex-col items-center px-4 py-8 text-muted-foreground">
          <SearchX className="mb-2 size-8" />
          <p className="text-sm">No sessions match your search</p>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground text-sm">
        No sessions yet. Select New Session to get started.
      </div>
    );
  }

  const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const staleSet = new Set(staleAgentIds);

  return (
    <ScrollArea className="min-h-0 flex-1">
      {/* Rows separate by whitespace, then by the selected fill — no rules.
          The mockup's `.sess` draws `padding: 7px 8px` and `background:
          --n-raised` on the selected row, and nothing between rows; a rule per
          pair would be the *third* cue for a boundary the row's own padding
          already makes. visual-language.md P7 is the rule this follows ("use the
          weakest separation cue that works: whitespace -> background shift ->
          border -> radius -> elevation") and session-list.md §Surface treatment
          states it for this pattern ("flat navigation surface; whitespace/
          background shift before borders/elevation"). */}
      {/* Headers and rows share one scroll container, so a group label scrolls
          with the rows it names rather than pinning. The App passes its group
          headers in `groups`; with no groups this is today's flat map, which
          is what keeps Web's DOM unchanged. */}
      <div className="flex flex-col p-2">
        {(groups ?? [{ key: '', header: null, sessions }]).map((group) => (
          <Fragment key={group.key}>
            {group.header}
            {group.sessions.map((session) => {
              const agent = agentById.get(session.agent_id);
              const domain = mapDomainState({
                session,
                agent,
                staleAgentIds: staleSet,
                clientSessionId,
                attachInFlightId,
                attachFailedId,
              });

              return (
                <SessionItem
                  key={session.session_id}
                  session={session}
                  domain={domain}
                  agentLabel={agent ? agentDisplayName(agent) : session.agent_id}
                  selected={selectedId === session.session_id}
                  onSelect={onSelect}
                  onConfigure={onConfigure}
                  onKill={onKill}
                  showRecency={showRowRecency}
                />
              );
            })}
          </Fragment>
        ))}
        {footer}
      </div>
    </ScrollArea>
  );
}

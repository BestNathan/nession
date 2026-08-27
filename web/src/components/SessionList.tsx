import { ArrowUp, ArrowDown, SearchX, Eye, ArrowUpRight, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { Session } from '../types';
import type { SortField, SortDirection } from '../hooks/useDashboard';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
  /** Agents that failed to answer the last force refresh — their sessions get
   *  a "may be stale" marker rather than being hidden or dropped. */
  staleAgents?: string[];
  onAttach: (session: Session) => void;
  onKill: (session: Session) => void;
  onPreview: (session: Session) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  isSearchActive: boolean;
}

/** Marker shown when a session's agent failed to answer the last refresh. */
function StaleBadge({ session }: { session: Session }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-testid={`stale-badge-${session.session_id}`}
            className="flex-shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded border border-muted-foreground/30 text-muted-foreground"
          >
            may be stale
          </span>
        }
      />
      <TooltipContent side="bottom">
        <p>Agent {session.agent_id} did not respond to the last refresh</p>
      </TooltipContent>
    </Tooltip>
  );
}

function SessionRow({
  session,
  isStale,
  onAttach,
  onKill,
  onPreview,
}: {
  session: Session;
  isStale: boolean;
  onAttach: (session: Session) => void;
  onKill: (session: Session) => void;
  onPreview: (session: Session) => void;
}) {
  return (
    <div className="flex items-center gap-2 md:gap-3 py-2.5 px-3 hover:bg-accent/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span
          className={cn(
            'w-2 h-2 rounded-full flex-shrink-0',
            session.status === 'active' ? 'bg-green-500' :
            session.status === 'detached' ? 'bg-emerald-500/60' :
            'bg-gray-400',
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="font-medium text-sm truncate">{session.session_name}</p>
            {isStale && <StaleBadge session={session} />}
          </div>
          <p className="text-xs text-muted-foreground">
            {session.agent_id} · {session.window_count} win · {session.attached_clients} client
            {session.attached_clients !== 1 ? 's' : ''}
            {session.status === 'detached' && ' · detached'}
            {session.status === 'zombie' && ' · zombie'}
          </p>
        </div>
      </div>
      <div className="flex gap-1.5 flex-shrink-0 whitespace-nowrap">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                onClick={() => onAttach(session)}
                aria-label="Attach"
                className="min-h-9 min-w-9 md:min-h-7 md:min-w-0"
              >
                <ArrowUpRight className="h-4 w-4 md:hidden" />
                <span className="hidden md:inline">Attach</span>
              </Button>
            }
          >
            Attach to session
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Attach to session</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPreview(session)}
                aria-label="Preview scrollback"
                className="min-h-9 min-w-9 md:min-h-7 md:min-w-0"
              >
                <Eye className="h-4 w-4" />
                <span className="hidden md:inline">Preview</span>
              </Button>
            }
          >
            Preview scrollback
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Preview scrollback</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                onClick={() => onKill(session)}
                aria-label="Kill"
                className="min-h-9 min-w-9 md:min-h-7 md:min-w-0 text-destructive border-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4 md:hidden" />
                <span className="hidden md:inline">Kill</span>
              </Button>
            }
          >
            Kill session
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Kill session</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function SessionList({
  sessions,
  loading,
  staleAgents,
  onAttach,
  onKill,
  onPreview,
  sortField,
  sortDirection,
  toggleSort,
  isSearchActive,
}: SessionListProps) {
  const staleSet = new Set(staleAgents ?? []);

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
    );
  }

  if (sessions.length === 0) {
    if (isSearchActive) {
      return (
        <div className="flex flex-col items-center py-8 text-muted-foreground">
          <SearchX size={32} className="mb-2" />
          <p className="text-sm">No agents or sessions match your search</p>
        </div>
      );
    }

    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No sessions for this agent
      </p>
    );
  }

  return (
    <ScrollArea data-testid="session-scroll" className="flex-1 min-h-0 rounded-md border">
      <div>
        {/* Sortable header row */}
        <div className="flex items-center gap-3 py-2 px-3 bg-muted/50 text-xs font-medium text-muted-foreground">
          <span className="w-2 flex-shrink-0" />
          <button className="flex-1 flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort('name')}>
            Name {sortField === 'name' && (sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
          <button
            className="hidden md:flex w-12 sm:w-16 items-center gap-1 hover:text-foreground"
            onClick={() => toggleSort('activity')}
          >
            Activity {sortField === 'activity' && (sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
          <span className="hidden md:block w-20 sm:w-[124px] flex-shrink-0" />
        </div>
        <div className="divide-y divide-border">
          {sessions.map((session) => (
            <SessionRow
              key={session.session_id}
              session={session}
              isStale={staleSet.has(session.agent_id)}
              onAttach={onAttach}
              onKill={onKill}
              onPreview={onPreview}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

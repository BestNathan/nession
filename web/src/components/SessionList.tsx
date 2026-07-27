import { ArrowUp, ArrowDown, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import type { Session } from '../types';
import type { SortField, SortDirection } from '../hooks/useDashboardHandlers';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
  onAttach: (session: Session) => void;
  onKill: (session: Session) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  isSearchActive: boolean;
}

export function SessionList({
  sessions,
  loading,
  onAttach,
  onKill,
  sortField,
  sortDirection,
  toggleSort,
  isSearchActive,
}: SessionListProps) {
  if (loading) {
    return (
      <div className="space-y-2">
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
            <div
              key={session.session_id}
              className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 py-2.5 px-3 hover:bg-accent/50 transition-colors"
            >
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
                  <p className="font-medium text-sm truncate">{session.session_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {session.agent_id} · {session.window_count} win · {session.attached_clients} client
                    {session.attached_clients !== 1 ? 's' : ''}
                    {session.status === 'detached' && ' · detached'}
                    {session.status === 'zombie' && ' · zombie'}
                  </p>
                </div>
              </div>
              <div className="flex gap-1.5 flex-shrink-0 whitespace-nowrap">
                <Button
                  size="sm"
                  onClick={() => onAttach(session)}
                  className="flex-1 md:flex-none min-h-11 md:min-h-7"
                >
                  Attach
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onKill(session)}
                  className="flex-1 md:flex-none min-h-11 md:min-h-7 text-destructive border-destructive hover:bg-destructive/10"
                >
                  Kill
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}

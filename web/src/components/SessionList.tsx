import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import type { Session } from '../types';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
  onAttach: (session: Session) => void;
  onKill: (session: Session) => void;
  attachingInProgress: boolean;
}

export function SessionList({
  sessions,
  loading,
  onAttach,
  onKill,
  attachingInProgress,
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
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No sessions for this agent
      </p>
    );
  }

  return (
    <ScrollArea className="max-h-64 rounded-md border">
      <div className="divide-y divide-border">
        {sessions.map((session) => (
          <div
            key={session.session_id}
            className="flex items-center gap-3 py-2.5 px-3 hover:bg-accent/50 transition-colors"
          >
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
            <div className="flex gap-1.5 flex-shrink-0">
              <Button
                size="sm"
                onClick={() => onAttach(session)}
                disabled={attachingInProgress}
              >
                Attach
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onKill(session)}
                className="text-destructive border-destructive hover:bg-destructive/10"
              >
                Kill
              </Button>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

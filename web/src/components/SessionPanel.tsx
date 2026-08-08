import { useState, useCallback, useMemo } from 'react';
import { SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { SidePanel } from './SidePanel';
import { AttachDialog, type AttachChoice } from './env/AttachDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import type { Session } from '../types';
import type { useAddressProbeCache } from '../hooks/useAddressProbeCache';

interface SessionPanelProps {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  currentSessionId: string;
  onSwitchSession: (session: Session, choice: AttachChoice) => void;
  probeCache: ReturnType<typeof useAddressProbeCache>;
  defaultOpen?: boolean;
}

interface SessionRowProps {
  session: Session;
  isCurrent: boolean;
  onAttach: () => void;
  onKill: () => void;
}

function SessionRow({ session, isCurrent, onAttach, onKill }: SessionRowProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 py-2.5 px-3 hover:bg-accent/50 transition-colors',
        isCurrent && 'bg-accent/30',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={cn(
            'w-2 h-2 rounded-full flex-shrink-0',
            session.status === 'active' ? 'bg-green-500' :
            session.status === 'detached' ? 'bg-emerald-500/60' :
            'bg-gray-400',
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-medium text-xs truncate">{session.session_name}</p>
            {isCurrent && (
              <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                Current
              </Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">
            {session.agent_id} · {session.window_count} win · {session.attached_clients} client
            {session.attached_clients !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
      <div className="flex gap-1.5">
        {!isCurrent && (
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs flex-1"
            onClick={onAttach}
            disabled={session.status === 'zombie'}
          >
            Attach
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs flex-1 text-destructive border-destructive hover:bg-destructive/10"
          onClick={onKill}
        >
          Kill
        </Button>
      </div>
    </div>
  );
}

function SessionListBody({
  error,
  onRetry,
  loading,
  filteredSessions,
  searchQuery,
  currentSessionId,
  onAttach,
  onKill,
}: {
  error: string | null;
  onRetry: () => void;
  loading: boolean;
  filteredSessions: Session[];
  searchQuery: string;
  currentSessionId: string;
  onAttach: (session: Session) => void;
  onKill: (session: Session) => void;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 px-3">
        <p className="text-xs text-destructive text-center">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    );
  }

  if (filteredSessions.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-muted-foreground">
        <SearchX size={28} className="mb-2" />
        <p className="text-xs">
          {searchQuery ? 'No sessions match your search' : 'No active sessions'}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="divide-y divide-border">
        {filteredSessions.map((session) => (
          <SessionRow
            key={session.session_id}
            session={session}
            isCurrent={session.session_id === currentSessionId}
            onAttach={() => onAttach(session)}
            onKill={() => onKill(session)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

export function SessionPanel({
  sessions,
  loading,
  error,
  onRetry,
  currentSessionId,
  onSwitchSession,
  probeCache,
  defaultOpen = false,
}: SessionPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [attachTarget, setAttachTarget] = useState<Session | null>(null);
  const [killTarget, setKillTarget] = useState<Session | null>(null);

  const filtered = useMemo(() => {
    if (!searchQuery) { return sessions; }
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) => s.session_name.toLowerCase().includes(q) || s.agent_id.toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

  const handleAttach = useCallback((session: Session) => {
    if (session.session_id === currentSessionId) { return; }
    setAttachTarget(session);
  }, [currentSessionId]);

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachTarget(null);
    onSwitchSession(session, choice);
  }, [onSwitchSession]);

  const handleKill = useCallback((session: Session) => {
    setKillTarget(session);
  }, []);

  return (
    <SidePanel defaultOpen={defaultOpen}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <span className="font-semibold text-sm">Sessions</span>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <Input
            placeholder="Filter sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 text-xs"
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0">
          <SessionListBody
            error={error}
            onRetry={onRetry}
            loading={loading}
            filteredSessions={filtered}
            searchQuery={searchQuery}
            currentSessionId={currentSessionId}
            onAttach={handleAttach}
            onKill={handleKill}
          />
        </div>

        {/* Dialogs */}
        <AttachDialog
          isOpen={attachTarget !== null}
          onClose={() => setAttachTarget(null)}
          session={attachTarget}
          onConfirm={confirmAttach}
          probeCache={probeCache}
        />
        <KillConfirmDialog
          isOpen={killTarget !== null}
          onClose={() => setKillTarget(null)}
          session={killTarget}
          onKilled={() => setKillTarget(null)}
        />
      </div>
    </SidePanel>
  );
}

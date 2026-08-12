import { useState, useCallback, useMemo } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, SearchX, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { AttachDialog, type AttachChoice } from './env/AttachDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import type { Session } from '../types';
import type { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { sessionIdAtom, attachToSessionAtom } from '../atoms/terminal';

interface SessionDropdownProps {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  currentSessionName: string;
  probeCache: ReturnType<typeof useAddressProbeCache>;
}

function SessionRow({
  session,
  isCurrent,
  onSelect,
  onKill,
}: {
  session: Session;
  isCurrent: boolean;
  onSelect: () => void;
  onKill: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 hover:bg-accent rounded-sm cursor-pointer transition-colors',
        isCurrent && 'bg-accent/30',
      )}
      onClick={isCurrent ? undefined : onSelect}
      role="option"
      aria-selected={isCurrent}
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
        <div className="flex items-center gap-1.5">
          <p className="text-sm truncate">{session.session_name}</p>
          {isCurrent && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {session.agent_id} · {session.window_count} win · {session.attached_clients} client
          {session.attached_clients !== 1 ? 's' : ''}
          {session.status === 'detached' && ' · detached'}
          {session.status === 'zombie' && ' · zombie'}
        </p>
      </div>
      {!isCurrent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs flex-shrink-0 text-destructive border-destructive hover:bg-destructive/10"
                onClick={(e) => { e.stopPropagation(); onKill(); }}
              />
            }
          >
            Kill
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Kill session</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function SessionDropdown({
  sessions,
  loading,
  error,
  onRetry,
  currentSessionName,
  probeCache,
}: SessionDropdownProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [attachTarget, setAttachTarget] = useState<Session | null>(null);
  const [killTarget, setKillTarget] = useState<Session | null>(null);
  const [currentSessionId] = useAtom(sessionIdAtom);
  const navigate = useNavigate();
  const doAttach = useSetAtom(attachToSessionAtom);

  const filtered = useMemo(() => {
    if (!searchQuery) { return sessions; }
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) => s.session_name.toLowerCase().includes(q) || s.agent_id.toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

  const handleSelect = useCallback((session: Session) => {
    if (session.session_id === currentSessionId) { return; }
    setOpen(false);
    setAttachTarget(session);
  }, [currentSessionId]);

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachTarget(null);
    doAttach({ session, choice, navigate });
  }, [doAttach, navigate]);

  const handleKill = useCallback((session: Session) => {
    setKillTarget(session);
  }, []);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" className="gap-1 font-normal" />
          }
        >
          Session:{' '}
          <strong className="text-foreground">{currentSessionName}</strong>
          <ChevronDown className="h-4 w-4 ml-0.5 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-72 p-0"
          finalFocus={false}
        >
          {/* Search */}
          <div className="px-2 pt-2 pb-1">
            <Input
              placeholder="Filter sessions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-xs"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {/* Content */}
          <div className="max-h-64">
            {error ? (
              <div className="flex flex-col items-center gap-2 py-4 px-3">
                <p className="text-xs text-destructive text-center">{error}</p>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : loading ? (
              <div className="flex flex-col gap-1 px-2 py-1">
                <Skeleton className="h-8 w-full rounded-sm" />
                <Skeleton className="h-8 w-full rounded-sm" />
                <Skeleton className="h-8 w-full rounded-sm" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center py-6 text-muted-foreground">
                <SearchX size={20} className="mb-1.5" />
                <p className="text-xs">
                  {searchQuery ? 'No sessions match your search' : 'No active sessions'}
                </p>
              </div>
            ) : (
              <ScrollArea className="max-h-56">
                <div className="p-1">
                  {filtered.map((session) => (
                    <SessionRow
                      key={session.session_id}
                      session={session}
                      isCurrent={session.session_id === currentSessionId}
                      onSelect={() => handleSelect(session)}
                      onKill={() => handleKill(session)}
                    />
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </>
  );
}

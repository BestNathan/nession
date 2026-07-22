import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import type { Agent } from '../types';
import { formatRelativeTime, formatUptime, getStatusVariant } from '../lib/format';
import { useAgentRename } from './useAgentRename';

interface AgentCardProps {
  agent: Agent;
  onClick: () => void;
  onRename?: (agent: Agent) => void;
}

export function AgentCard({ agent, onClick, onRename }: AgentCardProps) {
  const {
    editing, editValue, setEditValue, saving, inputRef,
    startEdit, save, handleKeyDown, clearName,
    displayName, isCustomName,
  } = useAgentRename(agent, onRename);

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:border-primary/50 group',
        agent.status === 'online' && 'border-green-500/30',
      )}
      onClick={onClick}
    >
      <CardContent className="p-4 space-y-1.5">
        {/* Status badge row */}
        <div className="flex items-center justify-between">
          <Badge variant={getStatusVariant(agent.status)} className="capitalize text-xs">
            {agent.status}
          </Badge>

          {!editing && (
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent"
              onClick={startEdit}
              title="Rename agent"
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Display name — main title */}
        {editing ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => void save()}
              disabled={saving}
              className="h-7 text-sm font-semibold"
              maxLength={64}
              placeholder="Display name"
            />
          </div>
        ) : (
          <h3 className="font-semibold truncate text-foreground leading-snug">
            {displayName}
          </h3>
        )}

        {/* Hostname subtitle */}
        <p className="text-xs text-muted-foreground/70 truncate font-mono">
          {agent.hostname}
          {isCustomName && (
            <button
              className="ml-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] hover:text-foreground"
              onClick={clearName}
              title="Reset to hostname"
            >
              × reset
            </button>
          )}
        </p>

        {/* Info row */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground pt-0.5">
          <span>
            {agent.session_count} session{agent.session_count !== 1 ? 's' : ''}
            {agent.active_sessions ? ` · ${agent.active_sessions} active` : ''}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span>{formatRelativeTime(agent.last_heartbeat)}</span>
        </div>

        {/* Version + uptime row */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground/60">
          {agent.metadata?.nession_version && (
            <>
              <span>v{agent.metadata.nession_version}</span>
              <span className="text-muted-foreground/30">·</span>
            </>
          )}
          {agent.registered_at && (
            <span>up {formatUptime(agent.registered_at)}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

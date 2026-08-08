import { Pencil, Monitor, Box } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { Agent } from '../types';
import { formatUptime, getStatusVariant } from '../lib/format';
import { useAgentRename } from '../hooks/useAgentRename';

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
      <CardContent className="flex flex-col p-4 gap-1.5">
        {/* Row 1: Status badge */}
        <div>
          <Badge variant={getStatusVariant(agent.status)} className="capitalize text-xs">
            {agent.status}
          </Badge>
        </div>

        {/* Row 2: Display name + edit button — inline */}
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
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="font-semibold truncate text-foreground leading-snug">
              {displayName}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={startEdit}
              title="Rename agent"
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </Button>
          </div>
        )}

        {/* Row 3: Hostname + reset */}
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

        {/* Row 4: Sessions · Version · Uptime — compact info row */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-0.5">
          <Monitor className="h-3 w-3 shrink-0" />
          <span>
            {agent.session_count} session{agent.session_count !== 1 ? 's' : ''}
          </span>
          {agent.metadata?.nession_version && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <Box className="h-3 w-3 shrink-0" />
              <span>v{agent.metadata.nession_version}</span>
            </>
          )}
          {agent.registered_at && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span>up {formatUptime(agent.registered_at)}</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

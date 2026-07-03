import { cn } from '@/lib/utils';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import type { Agent } from '../types';

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
}

function getStatusVariant(status: Agent['status']): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'online':   return 'default';
    case 'degraded': return 'secondary';
    case 'offline':  return 'outline';
  }
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {return 'just now';}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m ago`;}
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return `${hours}h ago`;}
  return `${Math.floor(hours / 24)}d ago`;
}

export function AgentCard({ agent, selected, onClick }: AgentCardProps) {
  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:border-primary/50',
        selected && 'ring-2 ring-primary',
        agent.status === 'online' && 'border-green-500/30',
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Badge variant={getStatusVariant(agent.status)} className="capitalize">
            {agent.status}
          </Badge>
        </div>
        <h3 className="font-semibold truncate text-foreground">{agent.hostname}</h3>
        <p className="text-sm text-muted-foreground">
          {agent.session_count} session{agent.session_count !== 1 ? 's' : ''} &middot; {formatRelativeTime(agent.last_heartbeat)}
        </p>
      </CardContent>
    </Card>
  );
}

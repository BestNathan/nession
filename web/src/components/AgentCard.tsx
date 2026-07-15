import { cn } from '@/lib/utils';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import type { Agent } from '../types';
import { formatRelativeTime, getStatusVariant } from '../lib/format';

interface AgentCardProps {
  agent: Agent;
  onClick: () => void;
}

export function AgentCard({ agent, onClick }: AgentCardProps) {
  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:border-primary/50',
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

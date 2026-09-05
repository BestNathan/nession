import { Badge } from './badge';
import { cn } from '@/lib/utils';
import type { ConnectionState } from '@/services/socket';

interface ConnectionStatusBadgeProps {
  status: ConnectionState;
  showPulse?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<ConnectionState, { color: string; text: string }> = {
  disconnected: { color: 'bg-destructive', text: 'Disconnected' },
  connecting: { color: 'bg-warning', text: 'Connecting...' },
  reconnecting: { color: 'bg-warning', text: 'Reconnecting...' },
  connected: { color: 'bg-success', text: 'Connected' },
};

export function ConnectionStatusBadge({ status, showPulse = true, className }: ConnectionStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Badge variant="outline" className={cn('flex items-center gap-2', className)}>
      <span className={cn('w-2 h-2 rounded-full', config.color, showPulse && 'animate-pulse')} />
      {config.text}
    </Badge>
  );
}

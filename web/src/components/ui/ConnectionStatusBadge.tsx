import { Badge } from './badge';
import { cn } from '@/lib/utils';
import type { ConnectionStatus } from '../../types';

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  showPulse?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; text: string }> = {
  disconnected: { color: 'bg-red-500', text: 'Disconnected' },
  connecting: { color: 'bg-amber-500', text: 'Connecting...' },
  connected: { color: 'bg-green-500', text: 'Connected' },
  authenticated: { color: 'bg-blue-500', text: 'Authenticated' },
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

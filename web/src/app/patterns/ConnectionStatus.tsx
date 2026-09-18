import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/lib/utils';
import type { ConnectionState } from '@/platform/socket';

/**
 * How this client's connection state is presented.
 *
 * This lives here, not in `components/ui`, because it knows what a connection
 * is. `components.md` draws the primitive → product-pattern → feature line at
 * exactly this point: a generic primitive may not know Nession's Session,
 * Workspace, Agent, or service state. It used to sit in
 * `components/ui/ConnectionStatusBadge.tsx`, importing `ConnectionState` from
 * `services/socket` and owning the user-facing labels — a shared primitive
 * bound to a service state machine from above it in the layer order (#774).
 *
 * The split is: this pattern owns *meaning* (which states exist, what they are
 * called, how each is toned), and `Badge` owns *presentation*.
 *
 * `pattern.connection-status` describes a richer model — independent continuity
 * dimensions for Agent reachability, Session lifecycle and this-client
 * attachment, which may coexist and which need not all be visible at once. This
 * component covers the attachment dimension only; it is the part the login
 * screen needs. The wider pattern is not implemented here and this comment is
 * not a claim that it is.
 */
interface ConnectionStatusProps {
  status: ConnectionState;
  showPulse?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<ConnectionState, { color: string; text: string }> = {
  disconnected: { color: 'bg-destructive', text: 'Disconnected' },
  connecting: { color: 'bg-warning', text: 'Connecting...' },
  reconnecting: { color: 'bg-warning', text: 'Reconnecting...' },
  connected: { color: 'bg-muted-foreground', text: 'Connected' },
};

export function ConnectionStatus({ status, showPulse = true, className }: ConnectionStatusProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Badge variant="outline" className={cn('flex items-center gap-2', className)}>
      <span className={cn('w-2 h-2 rounded-full', config.color, showPulse && 'animate-pulse')} />
      {config.text}
    </Badge>
  );
}

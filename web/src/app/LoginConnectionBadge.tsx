import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/lib/utils';
import type { ConnectionState } from '@/platform/socket';

/**
 * How this client's own connection state is presented on the login screen.
 *
 * This lives here, not in `components/ui`, because it knows what a connection
 * is. `components.md` draws the primitive → product-pattern → feature line at
 * exactly this point: a generic primitive may not know Nession's Session,
 * Workspace, Agent, or service state. It used to sit in
 * `components/ui/ConnectionStatusBadge.tsx`, importing `ConnectionState` from
 * `services/socket` and owning the user-facing labels — a shared primitive
 * bound to a service state machine from above it in the layer order (#774).
 *
 * The split is: this owns *meaning* (which states exist, what they are called,
 * how each is toned), and `Badge` owns *presentation*.
 *
 * ── Why the name, and why it is not a Product Pattern ───────────────────────
 *
 * It was called `ConnectionStatus` and sat in `app/patterns/`, which made two
 * components share one name and one of them look like the canonical pattern.
 * `pattern.connection-status` describes a richer model — independent continuity
 * dimensions for Agent reachability, Session lifecycle and this-client
 * attachment, which may coexist and which need not all be visible at once — and
 * its implementation is `product/session/patterns/ConnectionStatus.tsx`. This
 * component covers the attachment dimension only, for the one screen that needs
 * it before a session exists, and `LoginPage` is its only consumer. The name now
 * says so, and being single-consumer UI it is LoginPage's neighbour rather than
 * a pattern in its own right.
 */
interface LoginConnectionBadgeProps {
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

export function LoginConnectionBadge({ status, showPulse = true, className }: LoginConnectionBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Badge variant="outline" className={cn('flex items-center gap-2', className)}>
      <span className={cn('w-2 h-2 rounded-full', config.color, showPulse && 'animate-pulse')} />
      {config.text}
    </Badge>
  );
}

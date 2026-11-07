import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { ServerInfoMenu } from '@/platform/server/components/ServerInfoMenu';
import type { ConnectionState } from '@/platform/socket/types';

const SERVER_LABEL: Record<ConnectionState, string> = {
  connected: 'Server connected',
  connecting: 'Server connecting',
  reconnecting: 'Server reconnecting',
  disconnected: 'Server disconnected',
};

/**
 * The Web sidebar's service footer (#2851).
 *
 * The old footer mixed the server link with a node count and the active
 * Session's attachment state. This is the server dimension alone: one quiet
 * 5px mark and one sentence. Agents and locations live in their own entry above
 * it, and an offline Agent does not repaint this mark.
 */
export function SidebarServerStatus({
  connectionStatus,
}: {
  connectionStatus: ConnectionState;
}) {
  const healthy = connectionStatus === 'connected';
  return (
    <div
      data-testid="sidebar-footer"
      className="flex shrink-0 items-center gap-[var(--nession-shell-foot-gap)] border-t px-[var(--nession-shell-space-3)] py-[var(--nession-shell-foot-pad-y)] pb-[max(var(--nession-shell-foot-pad-y),env(safe-area-inset-bottom))]"
    >
      <span
        data-testid="sidebar-server-dot"
        aria-hidden="true"
        className={cn(
          'size-[length:var(--nession-shell-status-dot-size)] shrink-0 rounded-full',
          healthy ? 'bg-[var(--nession-action)]' : 'bg-destructive',
        )}
      />
      <span
        data-testid="sidebar-server-status"
        aria-label={SERVER_LABEL[connectionStatus]}
        className={cn('min-w-0 flex-1 truncate text-muted-foreground', chromeSansRole('caption'))}
      >
        {SERVER_LABEL[connectionStatus]}
      </span>
      <ServerInfoMenu variant="footer" />
    </div>
  );
}

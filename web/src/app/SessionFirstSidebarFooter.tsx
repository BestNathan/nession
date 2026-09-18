import { cn } from '@/lib/utils';
import type { ConnectionState } from '@/services/socket/types';
import { ConnectionStatus } from '@/product/session/components/ConnectionStatus';
import { ServerInfoMenu } from '@/platform/server/components/ServerInfoMenu';
import { resolveSessionChrome } from '@/product/session/model/sessionChrome';
import type { DomainState } from '@/product/session/model/domainState';

export interface SessionFirstSidebarFooterProps {
  /** The active Session's domain state, for the attachment/lifecycle line. */
  domain: DomainState | null;
  /** Server link state — one dimension, not a roll-up of the others. */
  connectionStatus: ConnectionState;
  /** Nodes the server knows about. */
  nodeCount: number;
}

/**
 * Verb-first label for the server link. The mockup's foot reads
 * "Connected · 3 nodes", so the state is a word rather than an icon.
 */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

/**
 * The sidebar's status footer: service state on the left, Session state on the
 * right.
 *
 * This is where the Web header's status line went (#748, SC1), and it takes the
 * mockup's shape: a 5px dot, the connection as a word, the node count, all in
 * monospace at `footFontSize`.
 *
 * **Healthy stays quiet, but it stays visible.** `visual-language.md` P6 and the
 * mockup agree on the intent — the mockup's own comment on this block is
 * "Healthy stays quiet; degraded may gain emphasis", and it renders the healthy
 * case as a 5px mark beside muted 10.5px text rather than as a badge. The
 * earlier gate went further and rendered *nothing* when healthy, which left the
 * foot an empty 17px strip.
 *
 * The dot takes the action colour in the steady state. That is the mockup's
 * drawing and the owner's ruling ("footer 也按 mockup 来"); it is a knowing
 * deviation from this repository's "healthy is neutral" reading of P6, recorded
 * here so the next reader does not read it as an oversight.
 *
 * `includeAgent` is false because the agent dimension is already reported on the
 * affected Session row — `session-list.md` puts reachability there, with
 * "conditional emphasis on affected rows only". `ConnectionStatus` renders each
 * dimension separately, so this does not collapse agent, session and attachment
 * into one lamp (`session-header.md`'s state-dimension rule).
 */
export function SessionFirstSidebarFooter({
  domain,
  connectionStatus,
  nodeCount,
}: SessionFirstSidebarFooterProps) {
  const chrome = domain ? resolveSessionChrome(domain) : null;
  const healthy = connectionStatus === 'connected';
  // Built as one string, not interpolated in JSX: a single text node keeps the
  // line truncatable as a unit and keeps `getByText` able to find it whole.
  const serviceLabel = `${CONNECTION_LABEL[connectionStatus]} · ${nodeCount} ${
    nodeCount === 1 ? 'node' : 'nodes'
  }`;

  return (
    <div className="flex w-full min-w-0 items-center gap-[var(--shell-foot-gap)]">
      <span
        data-testid="sidebar-foot-dot"
        aria-hidden="true"
        className={cn(
          'size-[length:var(--shell-status-dot-size)] shrink-0 rounded-full',
          healthy ? 'bg-[var(--action)]' : 'bg-destructive',
        )}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--shell-foot-font-size)] text-muted-foreground">
        {serviceLabel}
      </span>
      {domain && chrome && chrome.connection !== 'quiet' ? (
        <ConnectionStatus state={domain} includeAgent={false} />
      ) : null}
      <ServerInfoMenu variant="footer" />
    </div>
  );
}

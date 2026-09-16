import { ConnectionStatus } from '@/features/sessions/components/ConnectionStatus';
import { ServerInfoMenu } from '@/features/server/components/ServerInfoMenu';
import { resolveSessionChrome } from '@/features/sessions/model/sessionChrome';
import type { DomainState } from '@/features/sessions/model/domainState';

export interface SessionFirstSidebarFooterProps {
  /** The active Session's domain state, for the attachment/lifecycle line. */
  domain: DomainState | null;
}

/**
 * The sidebar's status footer: service identity on the left, Session state on
 * the right.
 *
 * This is where the Web header's status line went (#748, SC1). `includeAgent` is
 * false because the agent dimension is already reported on the affected Session
 * row — `session-list.md` puts reachability there, with "conditional emphasis on
 * affected rows only". `ConnectionStatus` renders each dimension separately, so
 * this does not collapse agent, session and attachment into one lamp
 * (`session-header.md`'s state-dimension rule).
 *
 * The gate is the same `resolveSessionChrome` rule the header used: a healthy
 * Session says nothing here. Without it the component renders a neutral member
 * even when all is well, which is exactly the "permanent healthy badge" P6 and
 * `session-header.md`'s anti-patterns rule out.
 */
export function SessionFirstSidebarFooter({ domain }: SessionFirstSidebarFooterProps) {
  const chrome = domain ? resolveSessionChrome(domain) : null;

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <ServerInfoMenu variant="footer" />
      {domain && chrome && chrome.connection !== 'quiet' ? (
        <ConnectionStatus state={domain} includeAgent={false} />
      ) : null}
    </div>
  );
}

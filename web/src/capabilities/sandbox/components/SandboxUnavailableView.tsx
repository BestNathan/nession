import { Badge } from '@/components/ui/badge';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

/**
 * The truthful no-Enter state (#3124): the Pane is unknown, or the host cannot
 * offer Enter. It never borrows a previous execution's report and never renders
 * a protected label.
 */
export function SandboxUnavailableView({ context }: { context: SandboxCurrentContext }) {
  return (
    <div data-testid="sandbox-unavailable" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={chromeSansRole('title')}>Sandbox</h2>
        <Badge data-testid="sandbox-status" variant="outline">
          {context.status}
        </Badge>
      </div>
      <p
        data-testid="sandbox-reason"
        className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}
      >
        {context.reason ?? 'This Agent cannot offer Sandbox Enter for the active Pane right now.'}
      </p>
      <p
        data-testid="sandbox-catalog-status"
        className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
      >
        Host capability: {context.catalog.status}
        {context.catalog.reason ? ` — ${context.catalog.reason}` : ''}
      </p>
      {context.catalog.detail.length > 0 ? (
        <ul data-testid="sandbox-catalog-detail" className="flex flex-col gap-1">
          {context.catalog.detail.map((detail, index) => (
            <li
              key={`${detail}-${index}`}
              data-testid={`sandbox-catalog-detail-${index}`}
              className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
            >
              {detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

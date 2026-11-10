import { Badge } from '@/components/ui/badge';
import {
  DetailHeader,
  DetailNote,
  DetailSurface,
} from '@/components/ui/resource-detail';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';

/**
 * The truthful no-Enter state (#3124): the Pane is unknown, or the host cannot
 * offer Enter. It never borrows a previous execution's report and never renders
 * a protected label.
 */
export function SandboxUnavailableView({ context }: { context: SandboxCurrentContext }) {
  return (
    <DetailSurface data-testid="sandbox-unavailable">
      <DetailHeader
        level="h2"
        title="Sandbox"
        badges={
          <Badge data-testid="sandbox-status" variant="outline">
            {context.status}
          </Badge>
        }
        description={
          <span data-testid="sandbox-reason">
            {context.reason ??
              'This Agent cannot offer Sandbox Enter for the active Pane right now.'}
          </span>
        }
      />
      <DetailNote data-testid="sandbox-catalog-status">
        Host capability: {context.catalog.status}
        {context.catalog.reason ? ` — ${context.catalog.reason}` : ''}
      </DetailNote>
      {context.catalog.detail.length > 0 ? (
        <ul data-testid="sandbox-catalog-detail" className="flex flex-col gap-1">
          {context.catalog.detail.map((detail, index) => (
            <li key={`${detail}-${index}`} data-testid={`sandbox-catalog-detail-${index}`}>
              <DetailNote>{detail}</DetailNote>
            </li>
          ))}
        </ul>
      ) : null}
    </DetailSurface>
  );
}

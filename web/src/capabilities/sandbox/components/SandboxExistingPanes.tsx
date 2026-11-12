import { Button } from '@/components/ui/button';
import { DetailGroup, DetailSection } from '@/components/ui/resource-detail';
import { detailRowClass } from '@/components/ui/resource-detailStyles';
import type { SandboxPaneRef } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

export interface SandboxExistingPanesProps {
  panes: SandboxPaneRef[];
  busy: boolean;
  onFocus: (paneId: string) => void;
}

/**
 * Sandbox Panes that still run after Return to Native (#3124). Returning is a
 * focus switch, not a teardown, so the capability must offer the way back.
 */
export function SandboxExistingPanes({ panes, busy, onFocus }: SandboxExistingPanesProps) {
  if (panes.length === 0) {
    return null;
  }
  return (
    <DetailSection title="Existing Sandbox Panes" level="h3">
      <DetailGroup data-testid="sandbox-existing-panes">
        {panes.map((pane) => (
          <div
            key={pane.pane_id}
            data-testid={`sandbox-existing-pane-${pane.pane_id}`}
            data-recipe-part="detail-row"
            className={detailRowClass}
          >
            <span className={cn(chromeMonoRole('code'), 'min-w-0 flex-1 break-all')}>
              {pane.pane_id} · {pane.backend}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid={`sandbox-focus-existing-${pane.pane_id}`}
              disabled={busy}
              onClick={() => onFocus(pane.pane_id)}
            >
              Focus
            </Button>
          </div>
        ))}
      </DetailGroup>
    </DetailSection>
  );
}

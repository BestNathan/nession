import { Button } from '@/components/ui/button';
import type { SandboxPaneRef } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
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
    <section className="flex min-w-0 flex-col gap-2" aria-label="Existing Sandbox Panes">
      <h3 className={chromeSansRole('primary')}>Existing Sandbox Panes</h3>
      <ul data-testid="sandbox-existing-panes" className="flex min-w-0 flex-col gap-2">
        {panes.map((pane) => (
          <li
            key={pane.pane_id}
            data-testid={`sandbox-existing-pane-${pane.pane_id}`}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[var(--nession-radius-surface)] bg-muted/30 px-2 py-1"
          >
            <span className={cn(chromeMonoRole('code'), 'min-w-0 break-all')}>
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
          </li>
        ))}
      </ul>
    </section>
  );
}

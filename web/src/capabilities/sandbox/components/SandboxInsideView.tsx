import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import {
  SandboxEffectiveFilesystem,
  SandboxEffectiveNetwork,
  SandboxEffectiveProcess,
  SandboxEffectiveResource,
  SandboxEffectiveSyscall,
} from './SandboxEffectivePolicy';
import { SandboxExecutionDetails } from './SandboxExecutionDetails';
import { SandboxPolicySummary } from './SandboxPolicySummary';
import {
  SandboxPolicyTabs,
  type SandboxTabId,
} from './SandboxPolicyTabs';

export interface SandboxInsideViewProps {
  context: SandboxCurrentContext;
  busy: boolean;
  onReturnToNative: () => void;
  onFocusPane: (paneId: string) => void;
  experience: 'web' | 'app';
  activeTab: SandboxTabId;
  onTabChange: (tab: SandboxTabId) => void;
}

function MissingPolicy() {
  return (
    <p data-testid="sandbox-inside-missing-policy" className={chromeSansRole('secondary')}>
      The Agent did not include the observed effective policy for this domain.
    </p>
  );
}

/**
 * The inside projection (#3124, #3143).
 *
 * The same six peer tabs as the outside composer, but every body is the
 * Agent's observed effective policy/evidence — never the last draft. The
 * Overview carries trust, execution identity and the Pane-only scope; the
 * five domain tabs carry their observed configuration and stay read-only.
 */
export function SandboxInsideView({
  context,
  busy,
  onReturnToNative,
  onFocusPane,
  experience,
  activeTab,
  onTabChange,
}: SandboxInsideViewProps) {
  const execution = context.execution;
  const policy = context.effective_policy;
  if (!execution) {
    return (
      <p data-testid="sandbox-inside-missing-execution" className={chromeSansRole('secondary')}>
        The Agent reports this Pane as inside, but the execution evidence is missing.
      </p>
    );
  }
  const otherPanes = context.sandbox_panes.filter(
    (pane) => pane.execution_id !== execution.execution_id,
  );

  const panels: Record<SandboxTabId, ReactNode> = {
    overview: (
      <div className="flex min-w-0 flex-col gap-5">
        <header className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={chromeSansRole('title')}>Inside Sandbox</h2>
            <Badge data-testid="sandbox-status" variant="secondary">
              inside
            </Badge>
            <Badge variant="outline" data-testid="sandbox-backend">
              {execution.backend}
            </Badge>
          </div>
          <p
            data-testid="sandbox-scope-note"
            className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
          >
            Only the current Pane&apos;s execution is covered. The shared tmux server, the original
            Native Pane and future Panes or Windows are not inside this Sandbox.
          </p>
        </header>

        <SandboxExecutionDetails context={context} />
        {policy ? <SandboxPolicySummary policy={policy} onSelectTab={onTabChange} /> : null}

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {context.native_pane ? (
            <Button
              type="button"
              data-testid="sandbox-return-native"
              disabled={busy}
              onClick={onReturnToNative}
            >
              Return to Native Pane
            </Button>
          ) : (
            <p
              data-testid="sandbox-no-native-pane"
              className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
            >
              This Session was created inside the Sandbox; there is no preserved Native Pane.
            </p>
          )}
        </div>

        {otherPanes.length > 0 ? (
          <section className="flex min-w-0 flex-col gap-2" aria-label="Other Sandbox Panes">
            <h3 className={chromeSansRole('primary')}>Other Sandbox Panes</h3>
            <ul className="flex min-w-0 flex-col gap-2">
              {otherPanes.map((pane) => (
                <li
                  key={pane.pane_id}
                  data-testid={`sandbox-pane-${pane.pane_id}`}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[var(--nession-radius-surface)] bg-muted/30 px-2 py-1"
                >
                  <span className={cn(chromeMonoRole('code'), 'min-w-0 break-all')}>
                    {pane.pane_id} · {pane.backend}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid={`sandbox-focus-${pane.pane_id}`}
                    disabled={busy}
                    onClick={() => onFocusPane(pane.pane_id)}
                  >
                    Focus
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    ),
    filesystem: policy ? (
      <SandboxEffectiveFilesystem policy={policy} mechanisms={execution.mechanisms} />
    ) : (
      <MissingPolicy />
    ),
    network: policy ? <SandboxEffectiveNetwork policy={policy} /> : <MissingPolicy />,
    process: policy ? <SandboxEffectiveProcess policy={policy} /> : <MissingPolicy />,
    resource: policy ? <SandboxEffectiveResource policy={policy} /> : <MissingPolicy />,
    syscall: policy ? <SandboxEffectiveSyscall policy={policy} /> : <MissingPolicy />,
  };

  return (
    <div
      data-testid="sandbox-inside"
      className={cn(
        'flex min-w-0 flex-col',
        experience === 'web' && 'min-h-0 flex-1',
      )}
    >
      <SandboxPolicyTabs
        experience={experience}
        value={activeTab}
        onValueChange={onTabChange}
        renderPanel={(tab) => panels[tab]}
      />
    </div>
  );
}

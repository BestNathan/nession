import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DetailEmpty,
  DetailGroup,
  DetailHeader,
  DetailSection,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { detailRowClass } from '@/components/ui/resource-detailStyles';
import { OperationActions } from '@/components/ui/operation-surface';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';
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
    <DetailEmpty data-testid="sandbox-inside-missing-policy">
      The Agent did not include the observed effective policy for this domain.
    </DetailEmpty>
  );
}

function InsideOverview({
  context,
  policy,
  busy,
  onReturnToNative,
  onFocusPane,
  onTabChange,
}: {
  context: SandboxCurrentContext;
  policy: SandboxCurrentContext['effective_policy'];
  busy: boolean;
  onReturnToNative: () => void;
  onFocusPane: (paneId: string) => void;
  onTabChange: (tab: SandboxTabId) => void;
}) {
  const execution = context.execution;
  if (!execution) {
    return null;
  }
  const otherPanes = context.sandbox_panes.filter(
    (pane) => pane.execution_id !== execution.execution_id,
  );
  return (
    <DetailSurface>
      <DetailHeader
        level="h2"
        title="Inside Sandbox"
        badges={
          <>
            <Badge data-testid="sandbox-status" variant="secondary">
              inside
            </Badge>
            <Badge variant="outline" data-testid="sandbox-backend">
              {execution.backend}
            </Badge>
          </>
        }
        description={
          <span data-testid="sandbox-scope-note">
            Only the current Pane&apos;s execution is covered. The shared tmux server, the
            original Native Pane and future Panes or Windows are not inside this Sandbox.
          </span>
        }
      />

      <SandboxExecutionDetails context={context} />
      {policy ? <SandboxPolicySummary policy={policy} onSelectTab={onTabChange} /> : null}

      <OperationActions>
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
          <DetailEmpty data-testid="sandbox-no-native-pane">
            This Session was created inside the Sandbox; there is no preserved Native Pane.
          </DetailEmpty>
        )}
      </OperationActions>

      {otherPanes.length > 0 ? (
        <DetailSection title="Other Sandbox Panes" level="h3">
          <DetailGroup>
            {otherPanes.map((pane) => (
              <div
                key={pane.pane_id}
                data-testid={`sandbox-pane-${pane.pane_id}`}
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
                  data-testid={`sandbox-focus-${pane.pane_id}`}
                  disabled={busy}
                  onClick={() => onFocusPane(pane.pane_id)}
                >
                  Focus
                </Button>
              </div>
            ))}
          </DetailGroup>
        </DetailSection>
      ) : null}
    </DetailSurface>
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
      <DetailEmpty data-testid="sandbox-inside-missing-execution">
        The Agent reports this Pane as inside, but the execution evidence is missing.
      </DetailEmpty>
    );
  }

  const panels: Record<SandboxTabId, ReactNode> = {
    overview: (
      <InsideOverview
        context={context}
        policy={policy}
        busy={busy}
        onReturnToNative={onReturnToNative}
        onFocusPane={onFocusPane}
        onTabChange={onTabChange}
      />
    ),
    filesystem: policy ? (
      <DetailSurface>
        <SandboxEffectiveFilesystem policy={policy} mechanisms={execution.mechanisms} />
      </DetailSurface>
    ) : (
      <MissingPolicy />
    ),
    network: policy ? (
      <DetailSurface>
        <SandboxEffectiveNetwork policy={policy} />
      </DetailSurface>
    ) : (
      <MissingPolicy />
    ),
    process: policy ? (
      <DetailSurface>
        <SandboxEffectiveProcess policy={policy} />
      </DetailSurface>
    ) : (
      <MissingPolicy />
    ),
    resource: policy ? (
      <DetailSurface>
        <SandboxEffectiveResource policy={policy} />
      </DetailSurface>
    ) : (
      <MissingPolicy />
    ),
    syscall: policy ? (
      <DetailSurface>
        <SandboxEffectiveSyscall policy={policy} />
      </DetailSurface>
    ) : (
      <MissingPolicy />
    ),
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

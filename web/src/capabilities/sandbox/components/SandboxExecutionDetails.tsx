import { Badge } from '@/components/ui/badge';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

function IdentityRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>{label}</dt>
      <dd data-testid={testId} className={cn(chromeMonoRole('code'), 'break-all')}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The verified execution's identity, mechanisms and warnings. This is the
 * Agent's evidence, not a restatement of the request.
 */
export function SandboxExecutionDetails({ context }: { context: SandboxCurrentContext }) {
  const execution = context.execution;
  if (!execution) {
    return null;
  }
  const paneValue = `${context.scope.pane_id ?? 'unknown'}${
    context.scope.pane_pid !== null && context.scope.pane_pid !== undefined
      ? ` · pid ${context.scope.pane_pid}`
      : ''
  }`;
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Execution identity">
      <h3 className={chromeSansRole('primary')}>Execution details</h3>
      <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <IdentityRow label="Execution" value={execution.execution_id} testId="sandbox-execution-id" />
        <IdentityRow
          label="Policy digest"
          value={execution.policy_digest}
          testId="sandbox-policy-digest"
        />
        <IdentityRow label="Pane" value={paneValue} testId="sandbox-pane-identity" />
        <IdentityRow
          label="Session instance"
          value={context.scope.session_instance_id ?? 'unknown'}
        />
      </dl>
      <div className="flex min-w-0 flex-wrap gap-1">
        {execution.mechanisms.map((mechanism) => (
          <Badge
            key={mechanism}
            variant="outline"
            data-testid={`sandbox-mechanism-${mechanism}`}
            className={chromeMonoRole('code')}
          >
            {mechanism}
          </Badge>
        ))}
      </div>
      {execution.warnings.length > 0 ? (
        <ul data-testid="sandbox-warnings" className="flex flex-col gap-1">
          {execution.warnings.map((warning, index) => (
            <li
              key={`${warning}-${index}`}
              data-testid={`sandbox-warning-${index}`}
              className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
            >
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

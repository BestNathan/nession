import { Badge } from '@/components/ui/badge';
import {
  DetailFact,
  DetailFacts,
  DetailNote,
  DetailSection,
} from '@/components/ui/resource-detail';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';

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
    <DetailSection title="Execution details" level="h3">
      <DetailFacts className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DetailFact label="Execution" mono valueTestId="sandbox-execution-id">
          {execution.execution_id}
        </DetailFact>
        <DetailFact label="Policy digest" mono valueTestId="sandbox-policy-digest">
          {execution.policy_digest}
        </DetailFact>
        <DetailFact label="Pane" mono valueTestId="sandbox-pane-identity">
          {paneValue}
        </DetailFact>
        <DetailFact label="Session instance" mono>
          {context.scope.session_instance_id ?? 'unknown'}
        </DetailFact>
      </DetailFacts>
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
            <li key={`${warning}-${index}`} data-testid={`sandbox-warning-${index}`}>
              <DetailNote>{warning}</DetailNote>
            </li>
          ))}
        </ul>
      ) : null}
    </DetailSection>
  );
}

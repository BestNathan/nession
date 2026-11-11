import { Button } from '@/components/ui/button';
import {
  DetailFact,
  DetailFacts,
  DetailHeader,
  DetailSurface,
} from '@/components/ui/resource-detail';
import { OperationActions, OperationError } from '@/components/ui/operation-surface';
import type { SandboxPolicyDraft } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import type { SandboxActionError } from '../model';

export interface SandboxConfirmViewProps {
  draft: SandboxPolicyDraft;
  busy: boolean;
  preflightValid: boolean;
  actionError: SandboxActionError | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The explicit Enter confirmation (#3124).
 *
 * It explains the two facts that matter before the transition: a **new**
 * isolated Pane is created, and the original Native Pane is preserved. A
 * failure leaves the Native Pane focused and the draft untouched.
 */
export function SandboxConfirmView({
  draft,
  busy,
  preflightValid,
  actionError,
  onConfirm,
  onCancel,
}: SandboxConfirmViewProps) {
  const read = draft.filesystem?.access.read.length ?? 0;
  const write = draft.filesystem?.access.write.length ?? 0;
  return (
    <DetailSurface data-testid="sandbox-confirm">
      <DetailHeader
        level="h2"
        title="Enter Sandbox?"
        description="Nession will allocate a new isolated Pane in this Session and run its shell under the verified isolation barrier. The original Native Pane stays alive and outside the Sandbox. Focus moves to the new Pane only after verification succeeds; a failure leaves the Native Pane focused and the draft unchanged."
      />
      <DetailFacts data-testid="sandbox-confirm-summary" className="gap-1.5">
        <DetailFact label="Network" inline>
          {draft.network?.mode ?? 'allow'}
        </DetailFact>
        <DetailFact label="Filesystem read paths" inline>
          {read}
        </DetailFact>
        <DetailFact label="Filesystem write paths" inline>
          {write}
        </DetailFact>
        <DetailFact label="Resource controls" inline>
          {draft.resource.length}
        </DetailFact>
        <DetailFact label="Syscall controls" inline>
          {draft.syscall.length}
        </DetailFact>
      </DetailFacts>
      {actionError ? (
        <OperationError testId="sandbox-enter-error">{actionError.message}</OperationError>
      ) : null}
      <OperationActions>
        <Button
          type="button"
          variant="outline"
          data-testid="sandbox-cancel-confirm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="sandbox-confirm-enter"
          disabled={busy || !preflightValid}
          onClick={onConfirm}
        >
          {busy ? 'Entering…' : 'Confirm Enter'}
        </Button>
      </OperationActions>
    </DetailSurface>
  );
}

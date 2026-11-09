import { Button } from '@/components/ui/button';
import type { SandboxPolicyDraft } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
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
    <div data-testid="sandbox-confirm" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className={chromeSansRole('title')}>Enter Sandbox?</h2>
        <p className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}>
          Nession will allocate a new isolated Pane in this Session and run its shell under the
          verified isolation barrier. The original Native Pane stays alive and outside the
          Sandbox. Focus moves to the new Pane only after verification succeeds; a failure leaves
          the Native Pane focused and the draft unchanged.
        </p>
      </header>
      <ul data-testid="sandbox-confirm-summary" className="flex flex-col gap-1">
        <li className={chromeSansRole('secondary')}>Network: {draft.network?.mode ?? 'allow'}</li>
        <li className={chromeSansRole('secondary')}>Filesystem read paths: {read}</li>
        <li className={chromeSansRole('secondary')}>Filesystem write paths: {write}</li>
        <li className={chromeSansRole('secondary')}>Resource controls: {draft.resource.length}</li>
        <li className={chromeSansRole('secondary')}>Syscall controls: {draft.syscall.length}</li>
      </ul>
      {actionError ? (
        <p
          data-testid="sandbox-enter-error"
          className={cn(chromeSansRole('secondary'), 'rounded-[var(--nession-radius-surface)] bg-destructive/10 px-2 py-1 text-destructive')}
        >
          {actionError.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          data-testid="sandbox-confirm-enter"
          disabled={busy || !preflightValid}
          onClick={onConfirm}
        >
          {busy ? 'Entering…' : 'Confirm Enter'}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="sandbox-cancel-confirm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

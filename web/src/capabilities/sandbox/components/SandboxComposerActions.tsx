import { Button } from '@/components/ui/button';
import type { SandboxPreflightResult } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxActionError } from '../model';

export interface SandboxComposerActionsProps {
  preflight: { signature: string; result: SandboxPreflightResult } | null;
  preflightValid: boolean;
  preflightBusy: boolean;
  busy: boolean;
  actionError: SandboxActionError | null;
  catalogStatus: string;
  catalogReason: string | null | undefined;
  onPreflight: () => void;
  onRequestEnter: () => void;
}

/** Preflight result, field errors and the two explicit transitions. */
export function SandboxComposerActions({
  preflight,
  preflightValid,
  preflightBusy,
  busy,
  actionError,
  catalogStatus,
  catalogReason,
  onPreflight,
  onRequestEnter,
}: SandboxComposerActionsProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {catalogStatus !== 'available' ? (
        <p
          data-testid="sandbox-catalog-status"
          className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
        >
          Host capability: {catalogStatus}
          {catalogReason ? ` — ${catalogReason}` : ''}
        </p>
      ) : null}
      {preflight?.result.error ? (
        <p data-testid="sandbox-preflight-error" className={cn(chromeSansRole('secondary'), 'text-destructive')}>
          {preflight.result.error}
        </p>
      ) : null}
      {preflight && !preflight.result.ok && preflight.result.errors.length > 0 ? (
        <ul data-testid="sandbox-preflight-errors" className="flex flex-col gap-1">
          {preflight.result.errors.map((error, index) => (
            <li
              key={`${error.field}-${index}`}
              data-testid={`sandbox-preflight-error-${index}`}
              className={cn(chromeSansRole('secondary'), 'text-destructive')}
            >
              <span className={chromeMonoRole('code')}>{error.field}</span>: {error.message}
            </li>
          ))}
        </ul>
      ) : null}
      {actionError ? (
        <p data-testid="sandbox-enter-error" className={cn(chromeSansRole('secondary'), 'text-destructive')}>
          {actionError.message}
        </p>
      ) : null}
      {preflight && preflightValid ? (
        <p data-testid="sandbox-preflight-ok" className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          Validated: {preflight.result.backend ?? 'backend'} · digest{' '}
          <span className={chromeMonoRole('code')}>{preflight.result.policy_digest}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="sandbox-preflight"
          disabled={preflightBusy || busy}
          onClick={onPreflight}
        >
          {preflightBusy ? 'Validating…' : 'Validate policy'}
        </Button>
        <Button
          type="button"
          data-testid="sandbox-enter"
          disabled={!preflightValid || busy}
          onClick={onRequestEnter}
        >
          Enter Sandbox
        </Button>
      </div>
      {!preflightValid ? (
        <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          Validate the current draft before Enter. Any edit invalidates the validation.
        </p>
      ) : null}
    </div>
  );
}

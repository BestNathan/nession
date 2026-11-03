import { AlertTriangle, ChevronRight, CircleAlert } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { SessionEnvBinding } from '@/capabilities/env/hooks/useSessionEnvBinding';
import { bindingStatus } from '@/capabilities/env/model/bindingStatus';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

export interface SessionEnvironmentSummaryProps {
  sessionId: string;
  sessionName: string | null;
  binding: SessionEnvBinding;
  onOpen: () => void;
}

/**
 * The App root's compact current-Session item (#2654): identity, profile
 * count and one observed-status line. Tapping pushes the Session Environment
 * view through the shell's single depth owner.
 */
export function SessionEnvironmentSummary({
  sessionId,
  sessionName,
  binding,
  onOpen,
}: SessionEnvironmentSummaryProps) {
  const status = bindingStatus(binding.binding, binding.error);
  const count = binding.binding?.desired_profiles.length ?? 0;
  const loading = binding.loading && !binding.binding;

  return (
    <button
      type="button"
      data-testid="env-session-summary"
      data-status={status.status}
      data-tone={status.tone}
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-2 border-b px-3 py-2 text-left transition-colors hover:bg-accent/50',
        status.tone === 'warning' && 'bg-warning/10 text-warning',
        status.tone === 'error' && 'bg-destructive/10 text-destructive',
      )}
    >
      {status.tone === 'warning' ? (
        <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
      ) : status.tone === 'error' ? (
        <CircleAlert aria-hidden className="size-3.5 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', chromeSansRole('primary'))}>
          {sessionName ?? sessionId}
        </span>
        <span
          className={cn(
            'block truncate',
            status.tone === 'quiet' || status.tone === 'info'
              ? 'text-muted-foreground'
              : undefined,
            chromeSansRole('metadata'),
          )}
        >
          {loading
            ? 'Reading environment…'
            : `${count} ${count === 1 ? 'profile' : 'profiles'} · ${status.title}`}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

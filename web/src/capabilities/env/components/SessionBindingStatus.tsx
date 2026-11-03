import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Info,
  Loader2,
} from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { SessionEnvBindingState } from '@/capabilities/env/types';

type Tone = 'quiet' | 'info' | 'warning' | 'error';

interface StatusView {
  status: string;
  tone: Tone;
  icon: typeof CheckCircle2;
  label: string;
  detail: string | null;
}

const TONES: Record<Tone, string> = {
  quiet: 'border-b text-muted-foreground',
  info: 'border-b bg-muted/30 text-muted-foreground',
  warning: 'border-b border-warning/30 bg-warning/10 text-warning',
  error: 'border-b border-destructive/30 bg-destructive/10 text-destructive',
};

function keyCount(count: number): string {
  return count === 1 ? '1 key' : `${count} keys`;
}

function describe(
  binding: SessionEnvBindingState | null,
  error: string | null,
  loading: boolean,
): StatusView | null {
  if (error) {
    return {
      status: 'unavailable',
      tone: 'warning',
      icon: AlertTriangle,
      label: 'Environment status unavailable',
      detail: error,
    };
  }
  if (!binding) {
    if (loading) {
      return null;
    }
    return {
      status: 'unavailable',
      tone: 'warning',
      icon: AlertTriangle,
      label: 'Environment status unavailable',
      detail: 'No binding state was returned.',
    };
  }

  const observed = binding.observed;
  if (binding.desired_revision === 0 && binding.desired_profiles.length === 0) {
    return {
      status: 'empty',
      tone: 'quiet',
      icon: Info,
      label: 'No environment applied',
      detail: 'Apply a profile to bind it to this Session.',
    };
  }
  if (!observed) {
    return {
      status: 'unavailable',
      tone: 'warning',
      icon: AlertTriangle,
      label: 'Environment status unavailable',
      detail:
        binding.error ??
        'The Agent did not report an observed state for this revision.',
    };
  }

  const revision =
    observed.applied_revision === binding.desired_revision
      ? `Revision ${observed.applied_revision} · ${keyCount(
          observed.managed_keys.length,
        )}`
      : `Requested revision ${binding.desired_revision} · applied ${
          observed.applied_revision
        } · ${keyCount(observed.managed_keys.length)}`;
  switch (observed.status) {
    case 'in_sync':
      return {
        status: 'in_sync',
        tone: 'quiet',
        icon: CheckCircle2,
        label: 'Environment in sync',
        detail: revision,
      };
    case 'pending_shell':
      return {
        status: 'pending_shell',
        tone: 'info',
        icon: Clock3,
        label: "Waiting for the shell's next prompt",
        detail: `${revision} · tmux is updated; the running shell converges at its next prompt.`,
      };
    case 'unsupported_shell':
      return {
        status: 'unsupported_shell',
        tone: 'warning',
        icon: AlertTriangle,
        label: 'Unsupported shell',
        detail: `${
          observed.last_error ?? 'This shell has no Session-local adapter.'
        } New panes and processes still inherit the environment.`,
      };
    case 'error':
      return {
        status: 'error',
        tone: 'error',
        icon: CircleAlert,
        label: 'Environment error',
        detail: `Revision ${observed.applied_revision} failed to apply: ${
          observed.last_error ?? 'the Agent reported a materialization error.'
        }`,
      };
    case 'applying':
      return {
        status: 'applying',
        tone: 'info',
        icon: Loader2,
        label: 'Applying environment',
        detail: revision,
      };
    default:
      return {
        status: observed.status,
        tone: 'info',
        icon: Clock3,
        label: `Environment ${observed.status}`,
        detail: revision,
      };
  }
}

export interface SessionBindingStatusProps {
  sessionId: string | null;
  binding: SessionEnvBindingState | null;
  loading: boolean;
  error: string | null;
}

/**
 * The current Session's Environment Binding, stated at the top of the
 * Environment capability page (#2701).
 *
 * "Active in current Session" answers *which profiles are selected*. This
 * answers *how far they got*: tmux only, waiting for the prompt, the running
 * shell, or a failure. The observed half is the Agent's report, never a claim
 * derived from the desired selection.
 */
export function SessionBindingStatus({
  sessionId,
  binding,
  loading,
  error,
}: SessionBindingStatusProps) {
  if (!sessionId) {
    return null;
  }
  const view = describe(binding, error, loading);
  if (!view) {
    return null;
  }

  const Icon = view.icon;
  return (
    <div
      data-testid="env-binding-status"
      data-status={view.status}
      data-tone={view.tone}
      className={cn(
        'flex items-start gap-2 px-4 py-2',
        TONES[view.tone],
        chromeSansRole('metadata'),
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          view.status === 'applying' && 'animate-spin',
        )}
      />
      <div className="min-w-0">
        <span data-testid="env-binding-status-label">{view.label}</span>
        {view.detail ? (
          <span data-testid="env-binding-status-detail" className="opacity-80">
            {' · '}
            {view.detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}

import type { SessionEnvBindingState } from '@/capabilities/env/types';

export type BindingTone = 'quiet' | 'info' | 'warning' | 'error';

export interface BindingStatusView {
  /** Observed status code, or `empty` / `unavailable`. */
  status: string;
  tone: BindingTone;
  /** One line for the Session context. */
  title: string;
  /** A consequence or failure reason, never a revision counter. */
  detail: string | null;
  /** At least one desired profile changed since materialization. */
  outdated: boolean;
}

/**
 * Translate the #170 binding state into the one observed-status line the
 * Environment surfaces show. Revision counters and managed-key lists belong to
 * the Details disclosure, not to the standing line.
 *
 * The observed half is authoritative. A desired selection with no observation
 * is `unavailable`, never `in_sync`;
 */
export function bindingStatus(
  binding: SessionEnvBindingState | null,
  error: string | null,
): BindingStatusView {
  const outdated = binding?.desired_profiles.some((profile) => profile.outdated) ?? false;

  if (error) {
    return {
      status: 'unavailable',
      tone: 'warning',
      title: 'Status unavailable',
      detail: error,
      outdated,
    };
  }
  if (!binding) {
    return {
      status: 'unavailable',
      tone: 'warning',
      title: 'Status unavailable',
      detail: 'No binding state was returned.',
      outdated: false,
    };
  }
  if (binding.desired_revision === 0 && binding.desired_profiles.length === 0) {
    return {
      status: 'empty',
      tone: 'quiet',
      title: 'No environment applied',
      detail: null,
      outdated: false,
    };
  }

  const observed = binding.observed;
  if (!observed) {
    return {
      status: 'unavailable',
      tone: 'warning',
      title: 'Status unavailable',
      detail:
        binding.error ??
        'The Agent did not report an observed state for this revision.',
      outdated,
    };
  }

  switch (observed.status) {
    case 'in_sync':
      return {
        status: 'in_sync',
        tone: 'quiet',
        title: 'In sync',
        detail: null,
        outdated,
      };
    case 'pending_shell':
      return {
        status: 'pending_shell',
        tone: 'info',
        title: 'Waiting for the next shell prompt',
        detail: 'The running shell updates at its next prompt.',
        outdated,
      };
    case 'unsupported_shell':
      return {
        status: 'unsupported_shell',
        tone: 'warning',
        title: 'Unsupported shell',
        detail: `${
          observed.last_error ?? 'This shell has no Session-local adapter.'
        } New panes and processes still inherit the environment.`,
        outdated,
      };
    case 'error':
      return {
        status: 'error',
        tone: 'error',
        title: 'Environment error',
        detail:
          observed.last_error ??
          'The Agent reported a materialization error.',
        outdated,
      };
    case 'applying':
      return {
        status: 'applying',
        tone: 'info',
        title: 'Applying the new revision',
        detail: null,
        outdated,
      };
    default:
      return {
        status: observed.status,
        tone: 'info',
        title: `Environment ${observed.status}`,
        detail: observed.last_error ?? null,
        outdated,
      };
  }
}

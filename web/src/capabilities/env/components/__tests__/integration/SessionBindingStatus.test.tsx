import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  SessionEnvBindingState,
  SessionEnvObservedState,
} from '@/capabilities/env/types';
import { SessionBindingStatus } from '@/capabilities/env/components/SessionBindingStatus';

const REF = { name: 'staging.env', source: 'server' as const };

function observed(
  overrides: Partial<SessionEnvObservedState> = {},
): SessionEnvObservedState {
  return {
    applied_revision: 2,
    status: 'in_sync',
    profiles: [REF],
    managed_keys: ['A'],
    ...overrides,
  };
}

function binding(
  overrides: Partial<SessionEnvBindingState> = {},
): SessionEnvBindingState {
  return {
    session_id: 's1',
    desired_revision: 2,
    desired_profiles: [{ profile: REF, phase: 'attach', outdated: false }],
    observed: observed(),
    ...overrides,
  };
}

function renderStatus(
  props: Partial<React.ComponentProps<typeof SessionBindingStatus>> = {},
) {
  return render(
    <SessionBindingStatus
      sessionId="s1"
      binding={binding()}
      loading={false}
      error={null}
      {...props}
    />,
  );
}

describe('SessionBindingStatus', () => {
  it('renders nothing without a current Session', () => {
    renderStatus({ sessionId: null });
    expect(screen.queryByTestId('env-binding-status')).not.toBeInTheDocument();
  });

  it('says when no environment is applied', () => {
    renderStatus({
      binding: binding({ desired_revision: 0, desired_profiles: [], observed: null }),
    });
    expect(screen.getByTestId('env-binding-status')).toHaveAttribute(
      'data-status',
      'empty',
    );
    expect(screen.getByTestId('env-binding-status-label')).toHaveTextContent(
      'No environment applied',
    );
  });

  it('states the in-sync revision and managed key count quietly', () => {
    renderStatus();
    const strip = screen.getByTestId('env-binding-status');
    expect(strip).toHaveAttribute('data-status', 'in_sync');
    expect(strip).toHaveAttribute('data-tone', 'quiet');
    expect(screen.getByTestId('env-binding-status-label')).toHaveTextContent(
      'Environment in sync',
    );
    expect(screen.getByTestId('env-binding-status-detail')).toHaveTextContent(
      'Revision 2 · 1 key',
    );
  });

  it('states the desired revision when it differs from the applied one', () => {
    renderStatus({
      binding: binding({
        desired_revision: 4,
        observed: observed({ applied_revision: 2 }),
      }),
    });
    expect(screen.getByTestId('env-binding-status-detail')).toHaveTextContent(
      'Requested revision 4 · applied 2',
    );
  });

  it('explains a shell that has not converged yet', () => {
    renderStatus({ binding: binding({ observed: observed({ status: 'pending_shell' }) }) });
    expect(screen.getByTestId('env-binding-status')).toHaveAttribute(
      'data-status',
      'pending_shell',
    );
    expect(screen.getByTestId('env-binding-status-label')).toHaveTextContent(
      "Waiting for the shell's next prompt",
    );
  });

  it('warns when the shell has no adapter, with the Agent’s reason', () => {
    renderStatus({
      binding: binding({
        observed: observed({
          status: 'unsupported_shell',
          shell: 'fish',
          last_error: 'No Session-local adapter for shell /usr/bin/fish.',
        }),
      }),
    });
    const strip = screen.getByTestId('env-binding-status');
    expect(strip).toHaveAttribute('data-status', 'unsupported_shell');
    expect(strip).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByTestId('env-binding-status-label')).toHaveTextContent(
      'Unsupported shell',
    );
    expect(screen.getByTestId('env-binding-status-detail')).toHaveTextContent(
      'No Session-local adapter for shell /usr/bin/fish.',
    );
    expect(screen.getByTestId('env-binding-status-detail')).toHaveTextContent(
      'New panes and processes still inherit the environment.',
    );
  });

  it('surfaces a materialization error as an error, not a warning', () => {
    renderStatus({
      binding: binding({
        observed: observed({
          status: 'error',
          last_error: 'tmux set-environment refused the key',
        }),
      }),
    });
    const strip = screen.getByTestId('env-binding-status');
    expect(strip).toHaveAttribute('data-status', 'error');
    expect(strip).toHaveAttribute('data-tone', 'error');
    expect(screen.getByTestId('env-binding-status-detail')).toHaveTextContent(
      'tmux set-environment refused the key',
    );
  });

  it('never renders an unobserved binding as in sync', () => {
    renderStatus({
      binding: binding({ observed: null, error: 'agent offline' }),
    });
    const strip = screen.getByTestId('env-binding-status');
    expect(strip).toHaveAttribute('data-status', 'unavailable');
    expect(screen.getByTestId('env-binding-status-label')).toHaveTextContent(
      'Environment status unavailable',
    );
    expect(screen.getByTestId('env-binding-status-detail')).toHaveTextContent(
      'agent offline',
    );
  });
});

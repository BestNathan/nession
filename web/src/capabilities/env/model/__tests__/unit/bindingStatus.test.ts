import { describe, it, expect } from 'vitest';
import type { SessionEnvBindingState } from '@/capabilities/env/types';
import { bindingStatus } from '@/capabilities/env/model/bindingStatus';

const REF = { name: 'staging.env', source: 'server' as const };

function binding(
  overrides: Partial<SessionEnvBindingState> = {},
): SessionEnvBindingState {
  return {
    session_id: 's1',
    desired_revision: 2,
    desired_profiles: [{ profile: REF, phase: 'attach', outdated: false }],
    observed: {
      applied_revision: 2,
      status: 'in_sync',
      profiles: [REF],
      managed_keys: ['A'],
    },
    ...overrides,
  };
}

describe('bindingStatus', () => {
  it('keeps a healthy Session to one quiet line, with no revision counter', () => {
    const view = bindingStatus(binding(), null);
    expect(view.status).toBe('in_sync');
    expect(view.tone).toBe('quiet');
    expect(view.title).toBe('In sync');
    expect(view.detail).toBeNull();
  });

  it('states the next-prompt boundary for pending_shell', () => {
    const view = bindingStatus(
      binding({
        observed: {
          applied_revision: 2,
          status: 'pending_shell',
          profiles: [REF],
          managed_keys: ['A'],
        },
      }),
      null,
    );
    expect(view.tone).toBe('info');
    expect(view.title).toBe('Waiting for the next shell prompt');
    expect(view.detail).toContain('next prompt');
  });

  it('elevates an unsupported shell with the Agent’s reason', () => {
    const view = bindingStatus(
      binding({
        observed: {
          applied_revision: 2,
          status: 'unsupported_shell',
          profiles: [REF],
          managed_keys: ['A'],
          last_error: 'No Session-local adapter for shell /usr/bin/fish.',
        },
      }),
      null,
    );
    expect(view.tone).toBe('warning');
    expect(view.title).toBe('Unsupported shell');
    expect(view.detail).toContain('No Session-local adapter for shell /usr/bin/fish.');
    expect(view.detail).toContain('New panes and processes still inherit the environment.');
  });

  it('separates a materialization error from a warning', () => {
    const view = bindingStatus(
      binding({
        observed: {
          applied_revision: 2,
          status: 'error',
          profiles: [REF],
          managed_keys: ['A'],
          last_error: 'tmux set-environment refused the key',
        },
      }),
      null,
    );
    expect(view.tone).toBe('error');
    expect(view.title).toBe('Environment error');
    expect(view.detail).toBe('tmux set-environment refused the key');
  });

  it('never reports an unobserved binding as in sync', () => {
    const view = bindingStatus(binding({ observed: null, error: 'agent offline' }), null);
    expect(view.status).toBe('unavailable');
    expect(view.tone).toBe('warning');
    expect(view.title).toBe('Status unavailable');
    expect(view.detail).toBe('agent offline');
  });

  it('uses the read error when the binding could not be read at all', () => {
    const view = bindingStatus(null, 'socket closed');
    expect(view.status).toBe('unavailable');
    expect(view.detail).toBe('socket closed');
  });

  it('reports an empty binding as no environment applied', () => {
    const view = bindingStatus(
      binding({ desired_revision: 0, desired_profiles: [], observed: null }),
      null,
    );
    expect(view.status).toBe('empty');
    expect(view.tone).toBe('quiet');
    expect(view.title).toBe('No environment applied');
  });

  it('carries the outdated flag for the explicit Reapply affordance', () => {
    const view = bindingStatus(
      binding({
        desired_profiles: [{ profile: REF, phase: 'attach', outdated: true }],
      }),
      null,
    );
    expect(view.outdated).toBe(true);
    expect(view.status).toBe('in_sync');
  });
});

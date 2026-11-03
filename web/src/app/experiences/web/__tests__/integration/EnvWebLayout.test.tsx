import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent, EnvFileInfo, Session } from '@/types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { stubEnvApi, type EnvStub } from '@/capabilities/env/__tests__/stubEnvSurface';
import type { SessionEnvBindingResponse } from '@/capabilities/env';
import { WIRE as SESSION_ENV_BINDING_GET_WIRE } from '@/generated/protocol/core/server-session-env-binding-get/v1';
import { WIRE as SESSION_ENV_BINDING_SET_WIRE } from '@/generated/protocol/core/server-session-env-binding-set/v1';
import { WIRE as SESSION_ENV_APPLY_WIRE } from '@/generated/protocol/core/server-session-env-apply/v1';
import { WIRE as SESSION_ENV_UNSET_WIRE } from '@/generated/protocol/core/server-session-env-unset/v1';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { EnvWebLayout } from '@/app/experiences/web/EnvWebLayout';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

function ctx(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session: null,
    agent: undefined,
    agents: [] as Agent[],
    domain: null,
    fileOps: null,
    experience: 'web',
    onToolChange: vi.fn(),
    ...overrides,
  };
}

const SESSION = { session_id: 's1', session_name: 'api' } as Session;
const STAGING = { name: 'staging.env', source: 'server' as const };

function binding(overrides: Partial<SessionEnvBindingResponse> = {}): SessionEnvBindingResponse {
  return {
    success: true,
    binding: {
      session_id: 's1',
      desired_revision: 2,
      desired_profiles: [{ profile: STAGING, phase: 'attach', outdated: false }],
      observed: {
        applied_revision: 2,
        status: 'in_sync',
        profiles: [STAGING],
        managed_keys: ['A'],
      },
    },
    warnings: [],
    ...overrides,
  };
}

function observed(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    applied_revision: 2,
    status,
    profiles: [STAGING],
    managed_keys: ['A'],
    ...overrides,
  };
}

describe('EnvWebLayout', () => {
  let stub: EnvStub;

  beforeEach(() => {
    stub = stubEnvApi();
    stub.setFiles([info('staging.env'), info('prod.env', { source: 'agent', agent_id: 'a1' })]);
    stub.setFile({
      success: true,
      content: 'A=1\nAPI_KEY=supersecret\n',
      in_use_by: [],
    });
  });

  afterEach(() => {
    stub.teardown();
  });

  it('without a Session, lays navigator and the profile-first empty detail', async () => {
    render(<EnvWebLayout ctx={ctx()} />);
    expect(screen.getByTestId('env-web-layout')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('env-detail-empty')).toHaveTextContent(
      'Select an environment to inspect its variables.',
    );
    expect(screen.queryByTestId('env-session-environment')).not.toBeInTheDocument();
  });

  it('selecting a profile opens its read-first detail', async () => {
    const user = userEvent.setup();
    render(<EnvWebLayout ctx={ctx()} />);
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('env-profile-row-server::staging.env'));

    await waitFor(() => expect(screen.getByTestId('env-profile-detail')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('env-var-masked-API_KEY')).toBeInTheDocument(),
    );
  });

  it('New environment opens the Edit depth; Cancel returns to the empty detail', async () => {
    const user = userEvent.setup();
    render(<EnvWebLayout ctx={ctx()} />);
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId('env-new-menu'));
    await user.click(await screen.findByTestId('env-new-profile'));
    expect(screen.getByTestId('env-profile-editor')).toBeInTheDocument();

    await user.click(screen.getByTestId('env-editor-cancel'));
    expect(screen.getByTestId('env-detail-empty')).toBeInTheDocument();
  });

  it('a dirty edit guards the switch to another profile through the Nession dialog', async () => {
    const user = userEvent.setup();
    render(<EnvWebLayout ctx={ctx()} />);
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('env-profile-row-server::staging.env'));
    await waitFor(() => expect(screen.getByTestId('env-profile-detail')).toBeInTheDocument());

    await user.click(screen.getByTestId('env-edit'));
    await waitFor(() =>
      expect(document.querySelector('.cm-content')?.textContent).toContain('A=1'),
    );
    const { EditorView } = await import('@uiw/react-codemirror');
    const view = EditorView.findFromDOM(
      document.querySelector('.cm-editor') as HTMLElement,
    );
    view?.dispatch({ changes: { from: view.state.doc.length, insert: 'B=2\n' } });
    await waitFor(() => expect(screen.getByTestId('env-editor-dirty')).toBeInTheDocument());

    await user.click(screen.getByTestId('env-profile-row-agent:a1:prod.env'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Discard unsaved changes?');

    await user.click(screen.getByTestId('env-guard-cancel'));
    expect(screen.getByTestId('env-profile-editor')).toBeInTheDocument();
  });

  it('with a Session, the main content is the Session Environment overview', async () => {
    stub.setBinding(binding());
    render(<EnvWebLayout ctx={ctx({ session: SESSION })} />);

    const view = await screen.findByTestId('env-session-environment');
    expect(view).toHaveAttribute('data-status', 'in_sync');
    expect(within(view).getByTestId('env-session-status-title')).toHaveTextContent('In sync');
    expect(within(view).getByTestId('env-session-profile-server::staging.env')).toHaveTextContent(
      'staging.env',
    );
    expect(screen.queryByTestId('env-detail-empty')).not.toBeInTheDocument();
    // A standing status line, not a full-width strip and not revision
    // telemetry.
    expect(within(view).queryByText(/revision/i)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(view).getByTestId('env-session-details'));
    expect(within(view).getByTestId('env-session-details-body')).toHaveTextContent(
      'Desired revision',
    );
    expect(within(view).getByTestId('env-session-details-body')).toHaveTextContent('Applied revision');
    expect(within(view).getByTestId('env-session-details-body')).toHaveTextContent('Managed keys');
  });

  it('shows the pending-prompt boundary and elevates an unsupported shell reason', async () => {
    stub.setBinding(
      binding({
        binding: {
          session_id: 's1',
          desired_revision: 2,
          desired_profiles: [{ profile: STAGING, phase: 'attach', outdated: false }],
          observed: observed('unsupported_shell', {
            shell: 'fish',
            last_error: 'No Session-local adapter for shell /usr/bin/fish.',
          }),
        },
      }),
    );
    render(<EnvWebLayout ctx={ctx({ session: SESSION })} />);

    const view = await screen.findByTestId('env-session-environment');
    expect(view).toHaveAttribute('data-status', 'unsupported_shell');
    expect(screen.getByTestId('env-session-status-title')).toHaveTextContent('Unsupported shell');
    expect(screen.getByTestId('env-session-status-detail')).toHaveTextContent(
      'No Session-local adapter for shell /usr/bin/fish.',
    );
    expect(screen.getByTestId('env-session-status-detail')).toHaveTextContent(
      'New panes and processes still inherit the environment.',
    );
  });

  it('Manage binding drafts the ordered selection, and Cancel makes no mutation', async () => {
    const user = userEvent.setup();
    stub.setBinding(binding());
    render(<EnvWebLayout ctx={ctx({ session: SESSION })} />);
    await screen.findByTestId('env-session-environment');

    await user.click(screen.getByTestId('env-manage-binding'));
    const draft = await screen.findByTestId('env-binding-draft');
    expect(within(draft).getByTestId('env-draft-profile-server::staging.env')).toBeInTheDocument();

    await user.click(within(draft).getByTestId('env-draft-add-agent:a1:prod.env'));
    expect(within(draft).getByTestId('env-draft-profile-agent:a1:prod.env')).toBeInTheDocument();
    // The draft's preview names effective keys/counts, never values.
    expect(within(draft).getByTestId('env-draft-preview')).toHaveTextContent(
      'effective variable',
    );

    await user.click(within(draft).getByTestId('env-draft-cancel'));
    expect(await screen.findByTestId('env-session-environment')).toBeInTheDocument();
    expect(
      stub.requests.filter((request) => request.type === SESSION_ENV_BINDING_SET_WIRE),
    ).toHaveLength(0);
  });

  it('Apply commits one replace-whole-binding request and returns to the Session view', async () => {
    const user = userEvent.setup();
    stub.setBinding(binding());
    render(<EnvWebLayout ctx={ctx({ session: SESSION })} />);
    await screen.findByTestId('env-session-environment');

    await user.click(screen.getByTestId('env-manage-binding'));
    const draft = await screen.findByTestId('env-binding-draft');
    await user.click(within(draft).getByTestId('env-draft-add-agent:a1:prod.env'));
    await user.click(within(draft).getByTestId('env-draft-up-agent:a1:prod.env'));
    await user.click(within(draft).getByTestId('env-draft-apply'));

    await waitFor(() =>
      expect(screen.getByTestId('env-session-environment')).toHaveAttribute(
        'data-status',
        'pending_shell',
      ),
    );

    const sets = stub.requests.filter(
      (request) => request.type === SESSION_ENV_BINDING_SET_WIRE,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].payload.session_id).toBe('s1');
    expect((sets[0].payload.profiles as Array<{ name: string }>).map((p) => p.name)).toEqual([
      'prod.env',
      'staging.env',
    ]);
    expect(
      stub.requests.filter(
        (request) =>
          request.type === SESSION_ENV_APPLY_WIRE || request.type === SESSION_ENV_UNSET_WIRE,
      ),
    ).toHaveLength(0);
  });

  it('a profile in the desired binding links back to the Session view', async () => {
    const user = userEvent.setup();
    stub.setBinding(binding());
    render(<EnvWebLayout ctx={ctx({ session: SESSION })} />);
    await screen.findByTestId('env-session-environment');

    await user.click(screen.getByTestId('env-profile-row-server::staging.env'));
    await waitFor(() => expect(screen.getByTestId('env-profile-detail')).toBeInTheDocument());
    expect(screen.getByTestId('env-profile-included')).toHaveTextContent('Included in binding');
    expect(screen.queryByTestId('env-apply-to-session')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('env-profile-session-link'));
    expect(await screen.findByTestId('env-session-environment')).toBeInTheDocument();
  });

  it('offers Reapply for an outdated profile and reads the result back', async () => {
    const user = userEvent.setup();
    stub.setBinding(
      binding({
        binding: {
          session_id: 's1',
          desired_revision: 2,
          desired_profiles: [{ profile: STAGING, phase: 'attach', outdated: true }],
          observed: observed('in_sync'),
        },
      }),
    );
    render(<EnvWebLayout ctx={ctx({ session: SESSION })} />);
    await screen.findByTestId('env-session-environment');
    expect(screen.getByTestId('env-session-outdated')).toBeInTheDocument();

    await user.click(screen.getByTestId('env-session-reapply'));
    await waitFor(() =>
      expect(screen.getByTestId('env-session-environment')).toHaveAttribute(
        'data-status',
        'pending_shell',
      ),
    );
    expect(
      stub.requests.filter(
        (request) => request.type === SESSION_ENV_BINDING_GET_WIRE,
      ).length,
    ).toBeGreaterThan(0);
  });
});

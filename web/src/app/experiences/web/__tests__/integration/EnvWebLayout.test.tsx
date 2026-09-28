import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent, EnvFileInfo, Session } from '@/types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { stubEnvApi, type EnvStub } from '@/capabilities/env/__tests__/stubEnvSurface';

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

  it('lays navigator and empty detail on the workspace grid', async () => {
    render(<EnvWebLayout ctx={ctx()} />);
    expect(screen.getByTestId('env-web-layout')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('env-detail-empty')).toHaveTextContent(
      'Select an environment to inspect its variables.',
    );
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

  it('the Session summary appears when the workspace names a Session', async () => {
    const session = { session_id: 's1', session_name: 'api' } as Session;
    stub.setActiveSessionFiles([{ name: 'staging.env', source: 'server', phase: 'attach' }]);
    render(<EnvWebLayout ctx={ctx({ session })} />);
    await waitFor(() =>
      expect(screen.getByTestId('env-session-summary')).toHaveTextContent(
        'Current Session · staging.env',
      ),
    );
  });

  it('a profile the Session was created with hides Remove behind an explanation', async () => {
    // The unset wire spares create-phase usage, so Remove cannot complete
    // there; the detail says so instead of offering an action that half-works.
    const user = userEvent.setup();
    const session = { session_id: 's1', session_name: 'api' } as Session;
    stub.setActiveSessionFiles([{ name: 'staging.env', source: 'server', phase: 'create' }]);
    render(<EnvWebLayout ctx={ctx({ session })} />);
    await waitFor(() => expect(screen.getByTestId('env-session-summary')).toBeInTheDocument());

    await user.click(screen.getByTestId('env-profile-row-server::staging.env'));
    await waitFor(() =>
      expect(screen.getByTestId('env-sourced-at-create')).toHaveTextContent(
        'Sourced at session creation',
      ),
    );
    expect(screen.queryByTestId('env-remove-from-session')).not.toBeInTheDocument();
    expect(screen.getByTestId('env-profile-active')).toBeInTheDocument();
  });
});

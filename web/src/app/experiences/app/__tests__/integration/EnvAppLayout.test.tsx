import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent, EnvFileInfo, Session } from '@/types';
import type {
  WorkspaceAppViewProps,
  WorkspacePush,
} from '@/app/workspace/workspaceContext';
import { stubEnvApi, type EnvStub } from '@/capabilities/env/__tests__/stubEnvSurface';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { EnvAppLayout } from '@/app/experiences/app/EnvAppLayout';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

function renderLayout(opts: { session?: Session | null } = {}) {
  const pushed: { current: WorkspacePush | null } = { current: null };
  const props: WorkspaceAppViewProps = {
    ctx: {
      session: opts.session ?? null,
      agent: undefined,
      agents: [] as Agent[],
      domain: null,
      fileOps: null,
      experience: 'app',
      onToolChange: vi.fn(),
    },
    depth: {
      setPush: vi.fn((push: WorkspacePush | null) => {
        pushed.current = push;
      }),
    },
  };
  render(<EnvAppLayout {...props} />);
  return { pushed };
}

describe('EnvAppLayout', () => {
  let stub: EnvStub;

  beforeEach(() => {
    stub = stubEnvApi();
    stub.setFiles([info('staging.env'), info('prod.env')]);
    stub.setFile({ success: true, content: 'A=1\n', in_use_by: [] });
  });

  afterEach(() => {
    stub.teardown();
  });

  it('the navigator sits at the capability root with no push declared', async () => {
    const { pushed } = renderLayout();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    expect(pushed.current).toBeNull();
  });

  it('tapping a profile pushes the detail through the shell depth control', async () => {
    const user = userEvent.setup();
    const { pushed } = renderLayout();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('env-profile-row-server::staging.env'));

    await waitFor(() => expect(pushed.current?.title).toBe('staging.env'));
    expect(screen.getByTestId('env-profile-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('env-navigator')).not.toBeInTheDocument();
  });

  it('the shell Back pops a clean detail back to the list', async () => {
    const user = userEvent.setup();
    const { pushed } = renderLayout();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('env-profile-row-server::staging.env'));
    await waitFor(() => expect(pushed.current?.title).toBe('staging.env'));

    pushed.current?.onLeave();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    await waitFor(() => expect(pushed.current).toBeNull());
  });

  it('Back from a dirty edit confirms through the capability guard, not the shell', async () => {
    const user = userEvent.setup();
    const { pushed } = renderLayout();
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
    // The badge renders from the editor's local draft, but the editor reports
    // dirty to the screen hook from a passive effect — drain the work queue so
    // the report has landed before invoking the depth's leave. (CI failed here
    // under load: the dispatch's microtask beat the effect flush.)
    await act(async () => {});

    pushed.current?.onLeave();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Discard unsaved changes?');
    // Still in Edit — nothing was abandoned.
    expect(screen.getByTestId('env-profile-editor')).toBeInTheDocument();

    await user.click(screen.getByTestId('env-guard-confirm'));
    await waitFor(() => expect(screen.getByTestId('env-profile-detail')).toBeInTheDocument());
  });

  it('the Edit depth names itself for the navigation bar', async () => {
    const user = userEvent.setup();
    const { pushed } = renderLayout();
    await waitFor(() =>
      expect(screen.getByTestId('env-profile-row-server::staging.env')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('env-new-menu'));
    await user.click(await screen.findByTestId('env-new-profile'));
    await waitFor(() => expect(pushed.current?.title).toBe('New environment'));
    expect(screen.getByTestId('env-profile-editor')).toBeInTheDocument();
  });
});

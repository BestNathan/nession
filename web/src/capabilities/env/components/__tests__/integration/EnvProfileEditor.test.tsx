import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@uiw/react-codemirror';
import type { Agent, EnvFileInfo, EnvWriteResponse } from '@/types';
import type { EnvProfileSaveInput } from '@/capabilities/env/hooks/useEnvProfileSave';

type OnSave = (input: EnvProfileSaveInput) => Promise<EnvWriteResponse>;

const contentHook = vi.hoisted(() => ({
  useEnvProfileContent: vi.fn(),
}));

vi.mock('@/capabilities/env/hooks/useEnvProfileContent', () => contentHook);

import { EnvProfileEditor } from '@/capabilities/env/components/EnvProfileEditor';
import type { EditorTarget } from '@/capabilities/env/hooks/useEnvironmentScreen';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    hostname: 'devbox-01',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    ...overrides,
  } as Agent;
}

function hookResult(overrides: Record<string, unknown> = {}) {
  return {
    content: 'A=1\n',
    inUseBy: [],
    loading: false,
    error: null,
    reload: vi.fn(),
    ...overrides,
  };
}

function renderEditor(overrides: Partial<Parameters<typeof EnvProfileEditor>[0]> = {}) {
  const onSave: Mock<OnSave> =
    (overrides.onSave as Mock<OnSave> | undefined) ??
    vi.fn<OnSave>(async () => ({ success: true }));
  const merged = {
    target: { kind: 'existing' } as EditorTarget,
    profile: info('a.env'),
    agents: [] as Agent[],
    onDirtyChange: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
    onSave,
  };
  render(<EnvProfileEditor {...merged} />);
  return merged;
}

async function waitForEditor() {
  await waitFor(() => {
    expect(document.querySelector('.cm-editor')).toBeTruthy();
  });
}

function typeInEditor(text: string) {
  const editor = document.querySelector('.cm-editor');
  const view = EditorView.findFromDOM(editor as HTMLElement);
  view?.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

describe('EnvProfileEditor — existing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contentHook.useEnvProfileContent.mockReturnValue(hookResult());
  });

  it('loads the profile source into the canonical editor, identity read-only', async () => {
    renderEditor();
    await waitForEditor();
    await waitFor(() =>
      expect(document.querySelector('.cm-content')?.textContent).toContain('A=1'),
    );
    expect(screen.queryByTestId('env-editor-name')).not.toBeInTheDocument();
    expect(screen.getByText('a.env · Server')).toBeInTheDocument();
    // Clean: nothing to save yet.
    expect(screen.getByTestId('env-editor-save')).toBeDisabled();
  });

  it('an edit marks the depth dirty, enables Save, and offers Review changes', async () => {
    const d = renderEditor();
    await waitForEditor();
    await waitFor(() =>
      expect(document.querySelector('.cm-content')?.textContent).toContain('A=1'),
    );

    typeInEditor('B=2\n');
    await waitFor(() => expect(screen.getByTestId('env-editor-dirty')).toBeInTheDocument());
    await waitFor(() => expect(d.onDirtyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByTestId('env-editor-save')).toBeEnabled();
    expect(screen.getByTestId('env-editor-review')).toBeInTheDocument();
  });

  it('Save hands the write to the parent; success ends the depth there', async () => {
    const d = renderEditor();
    await waitForEditor();
    await waitFor(() =>
      expect(document.querySelector('.cm-content')?.textContent).toContain('A=1'),
    );
    typeInEditor('B=2\n');
    await waitFor(() => expect(screen.getByTestId('env-editor-save')).toBeEnabled());

    const user = userEvent.setup();
    await user.click(screen.getByTestId('env-editor-save'));
    await waitFor(() => expect(d.onSave).toHaveBeenCalledTimes(1));
    const call = d.onSave.mock.calls[0][0];
    expect(call.ref).toEqual({ name: 'a.env', source: 'server', agent_id: undefined });
    expect(call.content).toBe('A=1\nB=2\n');
    expect(call.overwrite).toBe(true);
    expect(call.force).toBe(false);
  });

  it('an in-use profile explains the Session impact before writing, and never says Force', async () => {
    contentHook.useEnvProfileContent.mockReturnValue(
      hookResult({ inUseBy: ['api-tests', 'deploy'] }),
    );
    const d = renderEditor();
    await waitForEditor();
    await waitFor(() =>
      expect(document.querySelector('.cm-content')?.textContent).toContain('A=1'),
    );
    typeInEditor('B=2\n');
    await waitFor(() => expect(screen.getByTestId('env-editor-save')).toBeEnabled());

    const user = userEvent.setup();
    await user.click(screen.getByTestId('env-editor-save'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Save and update running sessions?');
    expect(dialog).toHaveTextContent('used by 2 running sessions (api-tests, deploy)');
    expect(dialog).not.toHaveTextContent(/force/i);
    expect(d.onSave).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('env-save-impact-confirm'));
    await waitFor(() => expect(d.onSave).toHaveBeenCalledTimes(1));
    expect(d.onSave.mock.calls[0][0].force).toBe(true);
  });

  it('Cancel returns to the detail through the guarded path', async () => {
    const d = renderEditor();
    await waitForEditor();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('env-editor-cancel'));
    expect(d.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('EnvProfileEditor — new', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contentHook.useEnvProfileContent.mockReturnValue(hookResult({ content: null }));
  });

  it('asks for name and location, and stays unsavable until named', async () => {
    const d = renderEditor({ target: { kind: 'new' }, profile: null, agents: [agent()] });
    await waitForEditor();
    expect(screen.getByText('New environment')).toBeInTheDocument();
    expect(screen.getByTestId('env-editor-save')).toBeDisabled();
    expect(screen.getByText('Name the environment to save it.')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByTestId('env-editor-name'), 'staging');
    expect(screen.getByTestId('env-editor-save')).toBeEnabled();

    await user.click(screen.getByTestId('env-editor-save'));
    await waitFor(() => expect(d.onSave).toHaveBeenCalledTimes(1));
    expect(d.onSave.mock.calls[0][0].ref).toEqual({
      name: 'staging.env',
      source: 'server',
      agent_id: undefined,
    });
    expect(d.onSave.mock.calls[0][0].overwrite).toBe(false);
  });

  it('the agent location asks which agent', async () => {
    renderEditor({ target: { kind: 'new' }, profile: null, agents: [agent()] });
    await waitForEditor();
    expect(screen.queryByTestId('env-editor-agent')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('env-editor-location'));
    await user.click(await screen.findByRole('option', { name: 'Agent' }));
    expect(screen.getByTestId('env-editor-agent')).toBeInTheDocument();
  });

  it('an exists answer escalates to Replace inside the depth', async () => {
    const onSave = vi
      .fn<OnSave>()
      .mockResolvedValueOnce({ success: false, exists: true })
      .mockResolvedValueOnce({ success: true });
    renderEditor({ target: { kind: 'new' }, profile: null, onSave });
    await waitForEditor();

    const user = userEvent.setup();
    await user.type(screen.getByTestId('env-editor-name'), 'a');
    await user.click(screen.getByTestId('env-editor-save'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Replace existing profile?');
    expect(dialog).toHaveTextContent('a.env already exists');

    await user.click(screen.getByTestId('env-save-overwrite-confirm'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0].overwrite).toBe(true);
  });
});

describe('EnvProfileEditor — duplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contentHook.useEnvProfileContent.mockReturnValue(hookResult({ content: 'BASE=1\n' }));
  });

  it('prefills the source content under a proposed name', async () => {
    renderEditor({
      target: { kind: 'duplicate', source: info('base.env') },
      profile: null,
    });
    await waitForEditor();
    expect(screen.getByText('Duplicate of base.env')).toBeInTheDocument();
    expect(screen.getByTestId('env-editor-name')).toHaveValue('base-copy.env');
    await waitFor(() =>
      expect(document.querySelector('.cm-content')?.textContent).toContain('BASE=1'),
    );
  });
});

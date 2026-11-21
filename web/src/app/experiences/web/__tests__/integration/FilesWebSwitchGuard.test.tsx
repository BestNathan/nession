// @vitest-environment jsdom
// #3959 — the composed Web Files transition: a guarded save that persists an
// older snapshot while the editor moved on must keep A, its newer draft and
// the one open decision. This wires the real layout, viewer, guard and dialog
// together (real React effect ordering), with the deterministic fixture
// filesystem standing in for the Agent.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { fixtureFileOps, fixtureFilesControl } from '@/app/fixture/fixtureFileOps';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { FilesWebLayout } from '@/app/experiences/web/FilesWebLayout';

const FILE = 'web/src/index.css';

function ctx(): WorkspaceContext {
  return {
    session: null,
    agent: undefined,
    agents: [],
    domain: null,
    fileOps: fixtureFileOps(),
    experience: 'web',
    onToolChange: vi.fn(),
  };
}

function tree(): HTMLElement {
  return within(screen.getByTestId('file-workspace')).getByRole('tree');
}

async function clickTree(name: string): Promise<void> {
  await waitFor(() =>
    expect(within(tree()).getAllByText(name, { exact: true }).length).toBeGreaterThan(0),
  );
  await userEvent.click(within(tree()).getAllByText(name, { exact: true })[0]);
}

function editor(): EditorView {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
  expect(view).not.toBeNull();
  return view!;
}

function typeIntoEditor(text: string): void {
  const view = editor();
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  });
}

describe('FilesWebLayout guarded Save & Switch (#3959)', () => {
  beforeEach(() => {
    fixtureFilesControl().reset();
    vi.clearAllMocks();
  });

  it('keeps A, the newer draft and the open decision when the guarded write persisted an older snapshot', async () => {
    const control = fixtureFilesControl();
    render(<FilesWebLayout ctx={ctx()} />);
    await clickTree('web');
    await clickTree('src');
    await clickTree('index.css');
    await waitFor(() => expect(screen.getByText(FILE, { exact: true })).toBeInTheDocument());

    // A is edited to B; the switch to App.tsx asks; Save submits B and the
    // fixture holds that write unresolved.
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    typeIntoEditor('B');
    control.holdNextWrite();
    await clickTree('App.tsx');
    const dialog = screen.getByTestId('files-web-unsaved-dialog');
    expect(dialog).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('files-web-switch-save'));
    await waitFor(() =>
      expect(screen.getByTestId('files-web-switch-save')).toHaveTextContent('Saving…'),
    );

    // The editor moves on to C while the guarded write of B is still pending.
    typeIntoEditor('C');
    await act(async () => {
      control.releaseHeldWrite();
    });

    // The write of B succeeded, but C is newer: A stays mounted and selected,
    // the draft stays visible and dirty, and the one decision stays open.
    await waitFor(() =>
      expect(screen.getByTestId('files-web-switch-save')).toHaveTextContent('Save and switch'),
    );
    expect(screen.getByText(FILE, { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('web/src/App.tsx', { exact: true })).not.toBeInTheDocument();
    expect(editor().state.doc.toString()).toContain('BC');
    expect(screen.getByTitle('Unsaved changes')).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByTestId('files-web-switch-error')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('index.css');
    expect(dialog).toHaveTextContent('App.tsx');
    const persisted = control.contentsOf(FILE);
    expect(persisted).toContain('B');
    expect(persisted).not.toContain('C');

    // Saving the current draft through the same decision now proceeds to B.
    await userEvent.click(screen.getByTestId('files-web-switch-save'));
    await waitFor(() =>
      expect(screen.queryByTestId('files-web-unsaved-dialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('web/src/App.tsx', { exact: true })).toBeInTheDocument();
    expect(control.contentsOf(FILE)).toContain('BC');
  });

  it('explicit Discard after the partial guarded save opens B without persisting the newer draft', async () => {
    const control = fixtureFilesControl();
    render(<FilesWebLayout ctx={ctx()} />);
    await clickTree('web');
    await clickTree('src');
    await clickTree('index.css');
    await waitFor(() => expect(screen.getByText(FILE, { exact: true })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    typeIntoEditor('B');
    control.holdNextWrite();
    await clickTree('App.tsx');
    await userEvent.click(screen.getByTestId('files-web-switch-save'));
    typeIntoEditor('C');
    await act(async () => {
      control.releaseHeldWrite();
    });
    await waitFor(() =>
      expect(screen.getByTestId('files-web-switch-save')).toHaveTextContent('Save and switch'),
    );

    await userEvent.click(screen.getByTestId('files-web-switch-discard'));
    await waitFor(() =>
      expect(screen.queryByTestId('files-web-unsaved-dialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('web/src/App.tsx', { exact: true })).toBeInTheDocument();
    const persisted = control.contentsOf(FILE);
    expect(persisted).toContain('B');
    expect(persisted).not.toContain('C');
  });
});

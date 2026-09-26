import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@uiw/react-codemirror';
import { describe, expect, it, vi } from 'vitest';
import { FilesAppLayout } from '@/app/experiences/app/FilesAppLayout';
import type { FileEntry, FileOps } from '@/capabilities/files';
import type { WorkspaceContext, WorkspacePush } from '@/app/workspace/workspaceContext';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ENTRIES: FileEntry[] = [
  { name: 'docs', path: 'docs', full_path: '/root/docs', is_dir: true, size: 0, modified: 0 },
  {
    name: 'visual-language.md',
    path: 'docs/visual-language.md',
    full_path: '/root/docs/visual-language.md',
    is_dir: false,
    size: 100,
    modified: 0,
  },
];

function makeFileOps(): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: ENTRIES }),
    readFile: vi.fn().mockResolvedValue({ path: '/f.txt', content: btoa('hello'), mime_type: 'text/plain' }),
    writeFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '/f.txt', success: true }),
    createDir: vi.fn().mockResolvedValue({ path: '/d', success: true }),
    renameFile: vi.fn().mockResolvedValue({ from: '/a', to: '/b', success: true }),
    getCwd: vi.fn().mockResolvedValue({ path: '/' }),
    uploadFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  };
}

const baseCtx: WorkspaceContext = {
  session: null,
  agent: undefined,
  agents: [],
  domain: null,
  fileOps: makeFileOps(),
  experience: 'app',
  onToolChange: vi.fn(),
};

/**
 * Render the layout with a spy in the shell's place.
 *
 * The depth it declares *is* the layout's navigation contract now (#1051): the
 * layout renders no bar of its own, so what it hands the shell is what the user
 * ends up seeing. A test that rendered a header itself would be asserting on its
 * own harness rather than on the composition.
 */
function renderLayout(ctx: WorkspaceContext = baseCtx) {
  const setPush = vi.fn<(push: WorkspacePush | null) => void>();
  render(<FilesAppLayout ctx={ctx} depth={{ setPush }} />);
  return { setPush };
}

/** The depth the layout last declared — `null` means it is at its root. */
function lastPush(setPush: ReturnType<typeof renderLayout>['setPush']): WorkspacePush | null {
  const calls = setPush.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

/** Drive a real content change through CodeMirror (the jsdom-safe path the
 * CodeMirrorEditor tests use) so FileViewer marks the editor dirty. */
async function makeEditorDirty() {
  await waitFor(() => {
    expect(document.querySelector('.cm-editor')).toBeTruthy();
  });
  const editor = document.querySelector('.cm-editor') as HTMLElement;
  const view = EditorView.findFromDOM(editor);
  expect(view).toBeTruthy();
  view!.focus();
  view!.dispatch({ changes: { from: 0, insert: 'x' } });
}

describe('FilesAppLayout', () => {
  it('renders the list full-screen with no sub-header of its own', () => {
    renderLayout();
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
  });

  it('declares no depth while it is at the capability root', () => {
    const { setPush } = renderLayout();
    expect(lastPush(setPush)).toBeNull();
  });

  it('sizes a file row name at the App primary role', async () => {
    // #1073: a file row's name is the row's work item — the same role a Session
    // row's name carries — so "a list row's name" has one answer rather than a
    // Tailwind default per list. The token is shared, so the assertion is on the
    // var rather than on a number: Web's desktop value lives at `:root` and the
    // App's replaces it under `[data-experience="app"]`.
    renderLayout();
    const name = (await screen.findByText('visual-language.md')).closest('span');
    expect(name?.className).toContain(
      'text-[length:var(--workspace-list-row-title-font-size)]',
    );
    expect(name?.className).not.toMatch(/(^|\s)text-sm(\s|$)/);
  });

  it('declares a pushed depth naming the file it opened', async () => {
    // The pushed page's title, and the one leave action for it. `#1051`'s Files
    // target is `< Files   App.tsx`: the shell draws that bar from this.
    const user = userEvent.setup();
    const { setPush } = renderLayout();
    await user.click(await screen.findByText('visual-language.md'));

    const push = lastPush(setPush);
    expect(push).not.toBeNull();
    expect(push?.title).toBe('visual-language.md');
    expect(typeof push?.onLeave).toBe('function');
  });

  it('renders no close affordance, so Back is the only way out', async () => {
    // The defect #1051 names: the viewer's ✕ and the sub-header's ← both left
    // the same editor. Neither is rendered here — the shell's header Back is the
    // one leave, and it reaches this layout's guard through `onLeave`.
    const user = userEvent.setup();
    renderLayout();
    await user.click(await screen.findByText('visual-language.md'));
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();
  });

  it('returns to the list when the shell calls the declared leave', async () => {
    const user = userEvent.setup();
    const { setPush } = renderLayout();
    await user.click(await screen.findByText('visual-language.md'));
    expect(screen.queryByTestId('files-app-layout')).not.toBeInTheDocument();

    act(() => {
      lastPush(setPush)?.onLeave();
    });

    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(lastPush(setPush)).toBeNull();
  });

  it('asks before leaving an unsaved editor, through the declared leave', async () => {
    const user = userEvent.setup();
    const { setPush } = renderLayout();
    await user.click(await screen.findByText('visual-language.md'));
    // Markdown opens in preview; raw view exposes the editor and the Edit toggle.
    await user.click(screen.getByText('Raw'));
    await user.click(await screen.findByText('Edit'));
    await makeEditorDirty();

    // Dirty leave → confirmation dialog, not an immediate pop. This is the
    // guard travelling with the state it protects: the shell does not know an
    // editor exists, which is why it must not be the thing that decides.
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByTestId('files-app-layout')).not.toBeInTheDocument();

    // Cancel keeps the editor.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(screen.queryByTestId('files-app-layout')).not.toBeInTheDocument();

    // Confirm discards and pops back to the list.
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    await user.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(lastPush(setPush)).toBeNull();
  });

  it('pops directly when the editor is clean even after a saved edit', async () => {
    const user = userEvent.setup();
    const { setPush } = renderLayout();
    await user.click(await screen.findByText('visual-language.md'));
    await user.click(screen.getByText('Raw'));
    await user.click(await screen.findByText('Edit'));
    await makeEditorDirty();

    // Save clears the dirty flag (FileViewer's toolbar Save)…
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    });

    // …so the declared leave pops without asking.
    act(() => {
      lastPush(setPush)?.onLeave();
    });
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(lastPush(setPush)).toBeNull();
  });

  it('clears the pushed depth when fileOps detaches then reattaches', async () => {
    const user = userEvent.setup();
    const setPush = vi.fn<(push: WorkspacePush | null) => void>();
    const depth = { setPush };
    const { rerender } = render(<FilesAppLayout ctx={baseCtx} depth={depth} />);
    await user.click(await screen.findByText('visual-language.md'));
    expect(screen.queryByTestId('files-app-layout')).not.toBeInTheDocument();

    rerender(<FilesAppLayout ctx={{ ...baseCtx, fileOps: null }} depth={depth} />);
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();

    rerender(<FilesAppLayout ctx={baseCtx} depth={depth} />);
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(lastPush(setPush)).toBeNull();
  });
});

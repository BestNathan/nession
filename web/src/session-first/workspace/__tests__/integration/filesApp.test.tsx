import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@uiw/react-codemirror';
import { describe, expect, it, vi } from 'vitest';
import { FilesAppLayout } from '@/session-first/workspace/tools/filesApp';
import type { FileEntry, FileOps } from '@/features/files';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';

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

const ctx: WorkspaceContext = {
  session: null,
  agent: undefined,
  domain: null,
  fileOps: makeFileOps(),
  experience: 'app',
  onToolChange: vi.fn(),
};

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
  it('renders the tree full-screen with no sub-header', () => {
    render(<FilesAppLayout ctx={ctx} />);
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
  });

  it('pushes the editor with a sub-header and back affordance', async () => {
    const user = userEvent.setup();
    render(<FilesAppLayout ctx={ctx} />);
    const row = await screen.findByText('visual-language.md');
    await user.click(row);
    expect(screen.getByTestId('files-app-nav')).toBeInTheDocument();
    expect(screen.getByTestId('files-app-back')).toBeInTheDocument();
    await user.click(screen.getByTestId('files-app-back'));
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
  });

  it('closes the pushed editor from the viewer close button and returns to the tree', async () => {
    const user = userEvent.setup();
    render(<FilesAppLayout ctx={ctx} />);
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    await user.click(await screen.findByText('visual-language.md'));
    expect(screen.queryByTestId('files-app-layout')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-app-nav')).toBeInTheDocument();
    expect(screen.getAllByText('visual-language.md').length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByLabelText('Close file'));
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
  });

  it('clears the selection when fileOps detaches then reattaches', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FilesAppLayout ctx={ctx} />);
    await user.click(await screen.findByText('visual-language.md'));
    expect(screen.queryByTestId('files-app-layout')).not.toBeInTheDocument();

    rerender(<FilesAppLayout ctx={{ ...ctx, fileOps: null }} />);
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();

    rerender(<FilesAppLayout ctx={ctx} />);
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();
  });

  it('asks before leaving an unsaved editor via the sub-header back', async () => {
    const user = userEvent.setup();
    render(<FilesAppLayout ctx={ctx} />);
    await user.click(await screen.findByText('visual-language.md'));
    // Markdown opens in preview; raw view exposes the editor and the Edit toggle.
    await user.click(screen.getByText('Raw'));
    await user.click(await screen.findByText('Edit'));
    await makeEditorDirty();

    // Dirty back → confirmation dialog, not an immediate pop.
    await user.click(screen.getByTestId('files-app-back'));
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByTestId('files-app-nav')).toBeInTheDocument();

    // Cancel keeps the editor.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-app-nav')).toBeInTheDocument();

    // Confirm discards and pops back to the tree.
    await user.click(screen.getByTestId('files-app-back'));
    await user.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
  });

  it('pops directly when the editor is clean even after a saved edit', async () => {
    const user = userEvent.setup();
    render(<FilesAppLayout ctx={ctx} />);
    await user.click(await screen.findByText('visual-language.md'));
    await user.click(screen.getByText('Raw'));
    await user.click(await screen.findByText('Edit'));
    await makeEditorDirty();

    // Save clears the dirty flag (FileViewer's toolbar Save)…
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    });

    // …so back pops without asking.
    await user.click(screen.getByTestId('files-app-back'));
    expect(screen.getByTestId('files-app-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('files-app-nav')).not.toBeInTheDocument();
  });
});

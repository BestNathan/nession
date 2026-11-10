import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@uiw/react-codemirror';
import { FilesWebLayout } from '@/app/experiences/web/FilesWebLayout';
import type { FileOps, FileEntry } from '@/capabilities/files';
import type { CapabilityFocus, WorkspaceContext } from '@/app/workspace/workspaceContext';
import type { Session } from '@/types';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const FILE: FileEntry = {
  name: 'f.txt', path: 'f.txt', full_path: '/root/f.txt', is_dir: false, size: 5, modified: 0,
};

function makeFileOps(): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [FILE] }),
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

function makeCtx(
  fileOps: FileOps | null,
  options: { focus?: CapabilityFocus; onFocusConsumed?: () => void } = {},
): WorkspaceContext {
  return {
    session: fileOps ? ({ session_id: 'sess' } as Session) : null,
    agent: undefined,
    agents: [],
    domain: null,
    fileOps,
    experience: 'web',
    onToolChange: vi.fn(),
    focus: options.focus,
    onFocusConsumed: options.onFocusConsumed,
  };
}

describe('FilesWebLayout (web layout)', () => {
  it('renders an explicit unavailable state when no file provider is resolved', () => {
    render(<FilesWebLayout ctx={makeCtx(null)} />);
    expect(screen.getByTestId('file-source-unavailable')).toHaveTextContent(
      'No file provider is available',
    );
  });

  it('root keeps the file-workspace testid and exposes the web layout grid', () => {
    render(<FilesWebLayout ctx={makeCtx(makeFileOps())} />);
    expect(screen.getByTestId('file-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('files-web-layout')).toBeInTheDocument();
  });

  it('shows the select-a-file hint before any file is opened', () => {
    render(<FilesWebLayout ctx={makeCtx(makeFileOps())} />);
    expect(screen.getByText('Select a file to view it.')).toBeInTheDocument();
  });

  it('opens a file in the detail pane and closes it', async () => {
    const user = userEvent.setup();
    render(<FilesWebLayout ctx={makeCtx(makeFileOps())} />);
    await user.click(await screen.findByText('f.txt'));
    expect(screen.getAllByText('f.txt').length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByLabelText('Close file'));
    expect(screen.getByText('Select a file to view it.')).toBeInTheDocument();
  });

  it('clears the selection when fileOps detaches then reattaches', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FilesWebLayout ctx={makeCtx(makeFileOps())} />);
    await user.click(await screen.findByText('f.txt'));
    expect(screen.getAllByText('f.txt').length).toBeGreaterThanOrEqual(2);

    rerender(<FilesWebLayout ctx={makeCtx(null)} />);
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();

    rerender(<FilesWebLayout ctx={makeCtx(makeFileOps())} />);
    expect(screen.getByText('Select a file to view it.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();
  });

  it('resolves a Terminal file focus against the Session CWD and opens it at the line', async () => {
    const fileOps = makeFileOps();
    fileOps.getCwd = vi.fn().mockResolvedValue({ path: 'src' });
    fileOps.listDir = vi.fn().mockResolvedValue({
      entries: [{
        name: 'f.txt', path: 'src/f.txt', full_path: '/root/src/f.txt',
        is_dir: false, size: 18, modified: 0,
      }],
    });
    fileOps.readFile = vi.fn().mockResolvedValue({
      path: 'src/f.txt', content: btoa('one\ntwo\nthree'), mime_type: 'text/plain',
    });
    const onFocusConsumed = vi.fn();

    render(
      <FilesWebLayout
        ctx={makeCtx(fileOps, {
          focus: { capabilityId: 'files', resourceId: 'f.txt', line: 2, column: 3 },
          onFocusConsumed,
        })}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.cm-editor')).toBeTruthy();
    });
    await waitFor(() => {
      const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
      const head = view!.state.selection.main.head;
      const line = view!.state.doc.lineAt(head);
      expect(line.number).toBe(2);
      expect(head - line.from + 1).toBe(3);
    });
    expect(fileOps.getCwd).toHaveBeenCalledWith('sess');
    expect(fileOps.listDir).toHaveBeenCalledWith('src');
    expect(onFocusConsumed).toHaveBeenCalled();
  });

  it('shows a recoverable message when the focused file does not resolve', async () => {
    const fileOps = makeFileOps();
    fileOps.getCwd = vi.fn().mockResolvedValue({ path: 'src' });
    fileOps.listDir = vi.fn().mockResolvedValue({ entries: [] });
    const onFocusConsumed = vi.fn();

    render(
      <FilesWebLayout
        ctx={makeCtx(fileOps, {
          focus: { capabilityId: 'files', resourceId: 'missing.py' },
          onFocusConsumed,
        })}
      />,
    );

    expect(await screen.findByTestId('files-web-handoff-error')).toHaveTextContent(
      'may have been moved or deleted',
    );
    expect(onFocusConsumed).toHaveBeenCalled();
  });
});

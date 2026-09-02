import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';
import type { FileOps, FileEntry } from '@/services/fileOps';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';

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

function makeCtx(fileOps: FileOps | null): WorkspaceContext {
  return {
    session: null,
    agent: undefined,
    domain: null,
    fileOps,
    experience: 'web',
    onToolChange: vi.fn(),
  };
}

describe('FileWorkspace (web layout)', () => {
  it('renders nothing while fileOps is unavailable (tool availability owns that state)', () => {
    const { container } = render(<FileWorkspace ctx={makeCtx(null)} />);
    expect(container.firstChild).toBeNull();
  });

  it('root keeps the file-workspace testid and exposes the web layout grid', () => {
    render(<FileWorkspace ctx={makeCtx(makeFileOps())} />);
    expect(screen.getByTestId('file-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('files-web-layout')).toBeInTheDocument();
  });

  it('shows the select-a-file hint before any file is opened', () => {
    render(<FileWorkspace ctx={makeCtx(makeFileOps())} />);
    expect(screen.getByText('Select a file')).toBeInTheDocument();
  });

  it('opens a file in the detail pane and closes it', async () => {
    const user = userEvent.setup();
    render(<FileWorkspace ctx={makeCtx(makeFileOps())} />);
    await user.click(await screen.findByText('f.txt'));
    expect(screen.getAllByText('f.txt').length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByLabelText('Close file'));
    expect(screen.getByText('Select a file')).toBeInTheDocument();
  });

  it('clears the selection when fileOps detaches then reattaches', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FileWorkspace ctx={makeCtx(makeFileOps())} />);
    await user.click(await screen.findByText('f.txt'));
    expect(screen.getAllByText('f.txt').length).toBeGreaterThanOrEqual(2);

    rerender(<FileWorkspace ctx={makeCtx(null)} />);
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();

    rerender(<FileWorkspace ctx={makeCtx(makeFileOps())} />);
    expect(screen.getByText('Select a file')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();
  });
});

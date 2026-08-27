import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';
import type { FileOps, FileEntry } from '@/services/fileOps';

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
    uploadFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  } as unknown as FileOps;
}

describe('FileWorkspace', () => {
  it('shows attach-first empty state when fileOps is null', () => {
    render(<FileWorkspace fileOps={null} />);
    expect(screen.getByText(/attach/i)).toBeInTheDocument();
    expect(screen.queryByText('f.txt')).not.toBeInTheDocument();
  });

  it('opens a file in the detail pane', async () => {
    render(<FileWorkspace fileOps={makeFileOps()} />);
    await userEvent.click(await screen.findByText('f.txt'));
    expect(screen.getAllByText('f.txt').length).toBeGreaterThanOrEqual(2);
  });

  it('clears selection when fileOps detaches then reattaches', async () => {
    const { rerender } = render(<FileWorkspace fileOps={makeFileOps()} />);
    await userEvent.click(await screen.findByText('f.txt'));
    expect(screen.getAllByText('f.txt').length).toBeGreaterThanOrEqual(2);

    rerender(<FileWorkspace fileOps={null} />);
    expect(screen.getByText(/attach/i)).toBeInTheDocument();

    rerender(<FileWorkspace fileOps={makeFileOps()} />);
    expect(screen.getByText('Select a file')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close file')).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileBrowser } from '../FileBrowser';
import type { FileOps, FileEntry } from '../../services/fileOps';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const FILE: FileEntry = { name: 'f.txt', path: 'f.txt', full_path: '/root/f.txt', is_dir: false, size: 5, modified: 0 };

function makeFileOps(entries: FileEntry[]): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries }),
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

describe('FileBrowser copy path', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('offers "Copy path" (relative) and "Copy full path" (absolute) on the context menu', async () => {
    render(<FileBrowser fileOps={makeFileOps([FILE])} onFileClick={vi.fn()} />);

    const fileRow = await screen.findByText('f.txt');
    fireEvent.contextMenu(fileRow);

    expect(await screen.findByText('Copy path')).toBeInTheDocument();
    expect(screen.getByText('Copy full path')).toBeInTheDocument();
  });

  it('copies the relative path for "Copy path"', async () => {
    render(<FileBrowser fileOps={makeFileOps([FILE])} onFileClick={vi.fn()} />);

    fireEvent.contextMenu(await screen.findByText('f.txt'));
    fireEvent.click(await screen.findByText('Copy path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('f.txt'));
  });

  it('copies the absolute path for "Copy full path"', async () => {
    render(<FileBrowser fileOps={makeFileOps([FILE])} onFileClick={vi.fn()} />);

    fireEvent.contextMenu(await screen.findByText('f.txt'));
    fireEvent.click(await screen.findByText('Copy full path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/root/f.txt'));
  });
});

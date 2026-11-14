import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileOps, FileEntry } from '@/capabilities/files';
import { FileList } from '@/capabilities/files/components/FileList';

function entry(name: string, isDir: boolean, parent = ''): FileEntry {
  const path = parent ? `${parent}/${name}` : name;
  return { name, path, full_path: `/workspace/${path}`, is_dir: isDir, size: 0, modified: 0 };
}

function ops(listDir: (path: string) => Promise<{ entries: FileEntry[] }>): FileOps {
  return { listDir } as unknown as FileOps;
}

describe('App FileList remote request boundary (#3451)', () => {
  it('lists a 500-directory parent with one request, without fetching decorative child counts', async () => {
    const children = Array.from({ length: 500 }, (_, i) => entry(`dir-${i}`, true));
    const listDir = vi.fn(async (path: string) => ({ entries: path === '' ? children : [] }));
    const onEnterDirectory = vi.fn();
    render(
      <FileList fileOps={ops(listDir)} path="" onFileClick={vi.fn()}
        onEnterDirectory={onEnterDirectory} />,
    );

    expect(await screen.findByText('dir-499')).toBeInTheDocument();
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(1));
    expect(listDir).toHaveBeenCalledWith('');
    fireEvent.click(screen.getByText('dir-0'));
    expect(onEnterDirectory).toHaveBeenCalledWith('dir-0');
    expect(listDir).toHaveBeenCalledTimes(1);
  });

  it('does not publish a stale parent answer after navigating to another directory', async () => {
    let finishOld!: (value: { entries: FileEntry[] }) => void;
    const old = new Promise<{ entries: FileEntry[] }>((resolve) => { finishOld = resolve; });
    const listDir = vi.fn((path: string) =>
      path === 'old' ? old : Promise.resolve({ entries: [entry('current.txt', false, 'new')] }));
    const onEntriesChange = vi.fn();
    const fileOps = ops(listDir);
    const props = { fileOps, onFileClick: vi.fn(), onEnterDirectory: vi.fn(), onEntriesChange };
    const { rerender } = render(<FileList {...props} path="old" />);
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('old'));
    rerender(<FileList {...props} path="new" />);
    expect(await screen.findByText('current.txt')).toBeInTheDocument();

    await act(async () => { finishOld({ entries: [entry('stale', true, 'old')] }); });
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
    expect(onEntriesChange).toHaveBeenCalledTimes(1);
    expect(onEntriesChange).toHaveBeenCalledWith([entry('current.txt', false, 'new')]);
    expect(listDir).toHaveBeenCalledTimes(2);
  });

  it('preserves errors, Retry, folder navigation and file activation without enrichment', async () => {
    const listDir = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ entries: [entry('folder', true), entry('readme.txt', false)] });
    const onFileClick = vi.fn();
    const onEnterDirectory = vi.fn();
    render(
      <FileList fileOps={ops(listDir)} path="" onFileClick={onFileClick}
        onEnterDirectory={onEnterDirectory} />,
    );

    expect(await screen.findByText('offline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('readme.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByText('folder'));
    fireEvent.click(screen.getByText('readme.txt'));
    expect(onEnterDirectory).toHaveBeenCalledWith('folder');
    expect(onFileClick).toHaveBeenCalledWith(entry('readme.txt', false));
    expect(listDir).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { FileBrowser } from '@/capabilities/files/components/FileBrowser';
import type { FileOps, FileEntry } from '@/capabilities/files';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const FILE: FileEntry = {
  name: 'f.txt',
  path: 'f.txt',
  full_path: '/root/f.txt',
  is_dir: false,
  size: 5,
  modified: 0,
};

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

function makeNestedFileOps(tree: Record<string, FileEntry[]>): FileOps {
  const listDir = vi.fn(async (path: string) => ({ entries: tree[path] ?? [] }));
  return {
    listDir,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    createDir: vi.fn(),
    renameFile: vi.fn(),
    uploadFile: vi.fn(),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  } as unknown as FileOps;
}

function renderFileBrowser(ui: ReactElement) {
  return render(<div style={{ height: 400 }}>{ui}</div>);
}

describe('FileBrowser copy path', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // The shared clipboard owner takes the async branch only on secure origins.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'isSecureContext');
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('offers "Copy path" (relative) and "Copy full path" (absolute) on the context menu', async () => {
    renderFileBrowser(<FileBrowser fileOps={makeFileOps([FILE])} onFileClick={vi.fn()} />);

    const fileRow = await screen.findByText('f.txt');
    fireEvent.contextMenu(fileRow);

    expect(await screen.findByText('Copy path')).toBeInTheDocument();
    expect(screen.getByText('Copy full path')).toBeInTheDocument();
  });

  it('copies the relative path for "Copy path"', async () => {
    renderFileBrowser(<FileBrowser fileOps={makeFileOps([FILE])} onFileClick={vi.fn()} />);

    fireEvent.contextMenu(await screen.findByText('f.txt'));
    fireEvent.click(await screen.findByText('Copy path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('f.txt'));
  });

  it('copies the absolute path for "Copy full path"', async () => {
    renderFileBrowser(<FileBrowser fileOps={makeFileOps([FILE])} onFileClick={vi.fn()} />);

    fireEvent.contextMenu(await screen.findByText('f.txt'));
    fireEvent.click(await screen.findByText('Copy full path'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/root/f.txt'));
  });
});

describe('FileBrowser parent directory button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is disabled when at root', async () => {
    renderFileBrowser(<FileBrowser fileOps={makeFileOps([])} onFileClick={vi.fn()} />);

    const parentBtn = await screen.findByLabelText('Parent directory');
    expect(parentBtn).toBeDisabled();
  });

  it('navigates from a nested path to the parent directory', async () => {
    const fileOps = makeNestedFileOps({
      '': [{ name: 'a', path: 'a', full_path: '/root/a', is_dir: true, size: 0, modified: 0 }],
      a: [{ name: 'b', path: 'a/b', full_path: '/root/a/b', is_dir: true, size: 0, modified: 0 }],
      'a/b': [{ name: 'c', path: 'a/b/c', full_path: '/root/a/b/c', is_dir: true, size: 0, modified: 0 }],
      'a/b/c': [],
    });

    renderFileBrowser(
      <FileBrowser fileOps={fileOps} onFileClick={vi.fn()} initialPath="a/b/c" />,
    );

    await waitFor(() => expect(fileOps.listDir).toHaveBeenCalledWith('a/b/c'));

    const parentBtn = await screen.findByLabelText('Parent directory');
    expect(parentBtn).toBeEnabled();
    fireEvent.click(parentBtn);

    await waitFor(() => {
      expect(fileOps.listDir).toHaveBeenCalledWith('a/b');
    });
    await waitFor(() => {
      expect(screen.getByText('b')).toBeInTheDocument();
    });
  });

  it('navigates from a single-segment path to root', async () => {
    const fileOps = makeNestedFileOps({
      '': [{ name: 'project', path: 'project', full_path: '/root/project', is_dir: true, size: 0, modified: 0 }],
      project: [],
    });

    renderFileBrowser(
      <FileBrowser fileOps={fileOps} onFileClick={vi.fn()} initialPath="project" />,
    );

    await waitFor(() => expect(fileOps.listDir).toHaveBeenCalledWith('project'));

    const parentBtn = await screen.findByLabelText('Parent directory');
    fireEvent.click(parentBtn);

    await waitFor(() => expect(fileOps.listDir).toHaveBeenCalledWith(''));
    const parentBtnAfter = await screen.findByLabelText('Parent directory');
    expect(parentBtnAfter).toBeDisabled();
  });
});

describe('FileBrowser tree expansion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads nested entries when expanding a folder', async () => {
    const fileOps = makeNestedFileOps({
      '': [{ name: 'src', path: 'src', full_path: '/root/src', is_dir: true, size: 0, modified: 0 }],
      src: [FILE],
    });

    renderFileBrowser(<FileBrowser fileOps={fileOps} onFileClick={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
    });
    expect(fileOps.listDir).toHaveBeenCalledWith('');

    fireEvent.click(screen.getByText('src'));

    await waitFor(() => {
      expect(screen.getByText('f.txt')).toBeInTheDocument();
    });
    expect(fileOps.listDir).toHaveBeenCalledWith('src');
  });
});

describe('FileBrowser create destination', () => {
  const SRC = { name: 'src', path: 'src', full_path: '/root/src', is_dir: true, size: 0, modified: 0 };
  const COMPONENTS = {
    name: 'components',
    path: 'src/components',
    full_path: '/root/src/components',
    is_dir: true,
    size: 0,
    modified: 0,
  };
  const FILE_IN_SRC = { name: 'a.txt', path: 'src/a.txt', full_path: '/root/src/a.txt', is_dir: false, size: 1, modified: 0 };

  const tree = () => ({
    '': [SRC],
    src: [COMPONENTS, FILE_IN_SRC],
    'src/components': [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a selected directory is the destination, including after navigation', async () => {
    const fileOps = makeNestedFileOps(tree());
    renderFileBrowser(<FileBrowser fileOps={fileOps} onFileClick={vi.fn()} initialPath="src" />);

    fireEvent.click(await screen.findByText('components'));
    fireEvent.click(await screen.findByLabelText('New file'));

    expect(screen.getByTestId('files-create-destination')).toHaveTextContent('In src/components');
    fireEvent.change(screen.getByLabelText('New file name'), { target: { value: 'Button.tsx' } });
    expect(screen.getByTestId('files-create-destination')).toHaveTextContent(
      'src/components/Button.tsx',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(fileOps.writeFile).toHaveBeenCalledWith('src/components/Button.tsx', '', {
        createOnly: true,
      }),
    );
  });

  it('a selected file resolves to its parent', async () => {
    const fileOps = makeNestedFileOps(tree());
    renderFileBrowser(<FileBrowser fileOps={fileOps} onFileClick={vi.fn()} initialPath="src" />);

    fireEvent.click(await screen.findByText('a.txt'));
    fireEvent.click(await screen.findByLabelText('New folder'));

    expect(screen.getByTestId('files-create-destination')).toHaveTextContent('In src');
    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'lib' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(fileOps.createDir).toHaveBeenCalledWith('src/lib', { createOnly: true }),
    );
  });

  it('a duplicate keeps the form and reports the conflict', async () => {
    const fileOps = makeNestedFileOps(tree());
    vi.mocked(fileOps.writeFile).mockRejectedValue(new Error('already_exists: src/components/Button.tsx'));
    renderFileBrowser(<FileBrowser fileOps={fileOps} onFileClick={vi.fn()} initialPath="src" />);

    fireEvent.click(await screen.findByText('components'));
    fireEvent.click(await screen.findByLabelText('New file'));
    fireEvent.change(screen.getByLabelText('New file name'), { target: { value: 'Button.tsx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.getByTestId('files-create-error')).toHaveTextContent('already exists'),
    );
    expect(screen.getByLabelText('New file name')).toHaveValue('Button.tsx');
    expect(screen.getByTestId('files-create-form')).toBeInTheDocument();
  });

  it('rejects a traversal name without calling the provider', async () => {
    const fileOps = makeNestedFileOps(tree());
    renderFileBrowser(<FileBrowser fileOps={fileOps} onFileClick={vi.fn()} initialPath="src" />);

    fireEvent.click(await screen.findByLabelText('New file'));
    fireEvent.change(screen.getByLabelText('New file name'), { target: { value: '../escape' } });

    expect(screen.getByTestId('files-create-error')).toHaveTextContent('/');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(fileOps.writeFile).not.toHaveBeenCalled();
  });
});

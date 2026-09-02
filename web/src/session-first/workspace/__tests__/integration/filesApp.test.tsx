import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilesAppLayout } from '@/session-first/workspace/tools/filesApp';
import type { FileEntry, FileOps } from '@/services/fileOps';
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
    uploadFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  } as unknown as FileOps;
}

const ctx: WorkspaceContext = {
  session: null,
  agent: undefined,
  domain: null,
  fileOps: makeFileOps(),
  experience: 'app',
  onToolChange: vi.fn(),
};

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
});

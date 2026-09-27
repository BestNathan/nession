import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { FileOps } from '@/capabilities/files';
import { AppFilesFolderSheet } from '@/app/experiences/app/AppFilesFolderSheet';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeFileOps(): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [] }),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    createDir: vi.fn(),
    renameFile: vi.fn(),
    getCwd: vi.fn().mockResolvedValue({ path: '/root' }),
    uploadFile: vi.fn(),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  };
}

describe('AppFilesFolderSheet', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    vi.clearAllMocks();
  });

  it('copies the workspace-relative path and closes', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const onOpenChange = vi.fn();

    render(
      <AppFilesFolderSheet
        open
        onOpenChange={onOpenChange}
        folderTitle="docs"
        relativeDir="docs"
        sessionId="sess-1"
        fileOps={makeFileOps()}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy path' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('docs');
      expect(toast.success).toHaveBeenCalledWith('Path copied');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

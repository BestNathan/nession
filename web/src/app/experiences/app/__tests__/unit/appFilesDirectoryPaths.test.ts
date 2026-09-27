import { describe, expect, it, vi } from 'vitest';
import type { FileOps } from '@/capabilities/files';
import {
  directoryRelativePath,
  resolveDirectoryFullPath,
} from '@/app/experiences/app/appFilesDirectoryPaths';

describe('directoryRelativePath', () => {
  it('uses dot at workspace root', () => {
    expect(directoryRelativePath('')).toBe('.');
  });

  it('returns the workspace-relative path elsewhere', () => {
    expect(directoryRelativePath('docs/src')).toBe('docs/src');
  });
});

describe('resolveDirectoryFullPath', () => {
  it('uses getCwd at root', async () => {
    const fileOps = {
      getCwd: vi.fn().mockResolvedValue({ path: '/root' }),
      listDir: vi.fn(),
    } as unknown as FileOps;
    await expect(resolveDirectoryFullPath(fileOps, 'sess', '')).resolves.toBe('/root');
  });

  it('reads full_path from the parent listing', async () => {
    const fileOps = {
      getCwd: vi.fn(),
      listDir: vi.fn((path: string) => {
        if (path === '') {
          return Promise.resolve({
            entries: [
              {
                name: 'docs',
                path: 'docs',
                full_path: '/root/docs',
                is_dir: true,
                size: 0,
                modified: 0,
              },
            ],
          });
        }
        return Promise.resolve({ entries: [] });
      }),
    } as unknown as FileOps;
    await expect(resolveDirectoryFullPath(fileOps, 'sess', 'docs')).resolves.toBe('/root/docs');
  });
});

import { describe, expect, it } from 'vitest';
import { filesFocusHandoff, parentDirectoryPath } from '../../appFilesPathUtils';
import { parseWorkspaceFileLink } from '@/product/terminal/workspaceFileLinks';

describe('appFilesPathUtils', () => {
  it('derives parent directory paths', () => {
    expect(parentDirectoryPath('')).toBe('');
    expect(parentDirectoryPath('src')).toBe('');
    expect(parentDirectoryPath('src/components/App.tsx')).toBe('src/components');
  });

  it('reads files focus handoff', () => {
    expect(filesFocusHandoff(undefined)).toBeNull();
    expect(
      filesFocusHandoff({ capabilityId: 'files', resourceId: 'src/a.ts', line: 3 }),
    ).toEqual({ path: 'src/a.ts', line: 3 });
  });
});

describe('parseWorkspaceFileLink', () => {
  it('parses path and line from compiler output', () => {
    expect(parseWorkspaceFileLink('error at src/foo.rs:128:9')).toEqual({
      path: 'src/foo.rs',
      line: 128,
    });
  });

  it('rejects absolute paths', () => {
    expect(parseWorkspaceFileLink('/etc/passwd')).toBeNull();
  });
});

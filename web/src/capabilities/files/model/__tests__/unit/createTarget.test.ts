import { describe, expect, it } from 'vitest';
import type { ExplorerNode } from '@/platform/explorer';
import {
  joinPath,
  parentPathOf,
  resolveCreateTarget,
  validateEntryName,
} from '@/capabilities/files/model/createTarget';
import { fileErrorKind, fileErrorMessage } from '@/capabilities/files/model/fileErrors';

function node(kind: 'file' | 'directory', uri: string): ExplorerNode {
  const segments = uri.split('/');
  const name = segments[segments.length - 1] ?? uri;
  return { id: uri, uri, name, kind, capabilities: {} };
}

describe('create-target resolution', () => {
  it('selected directory -> itself', () => {
    expect(
      resolveCreateTarget({ selected: [node('directory', 'src/components')], currentPath: 'docs' })
        .parentPath,
    ).toBe('src/components');
  });

  it('selected file -> its parent', () => {
    expect(
      resolveCreateTarget({ selected: [node('file', 'src/components/Button.tsx')], currentPath: 'docs' })
        .parentPath,
    ).toBe('src/components');
  });

  it('no selection uses the active node, then the browse directory', () => {
    expect(
      resolveCreateTarget({ active: node('file', 'a/b.txt'), currentPath: 'docs' }).parentPath,
    ).toBe('a');
    expect(resolveCreateTarget({ currentPath: 'docs' }).parentPath).toBe('docs');
  });

  it('a right-clicked directory wins over the current browse position', () => {
    expect(
      resolveCreateTarget({
        selected: [node('directory', 'selected')],
        currentPath: 'docs',
        contextTarget: node('directory', 'src/lib'),
      }).parentPath,
    ).toBe('src/lib');
  });

  it('a right-clicked file resolves to its parent', () => {
    expect(
      resolveCreateTarget({ currentPath: 'docs', contextTarget: node('file', 'src/lib/a.ts') })
        .parentPath,
    ).toBe('src/lib');
  });

  it('joins paths without a leading slash at the root', () => {
    expect(joinPath('', 'a.ts')).toBe('a.ts');
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts');
    expect(parentPathOf('src/a.ts')).toBe('src');
    expect(parentPathOf('a.ts')).toBe('');
  });
});

describe('entry-name validation', () => {
  it('accepts one ordinary segment', () => {
    expect(validateEntryName('Button.tsx')).toBeNull();
    expect(validateEntryName('组件')).toBeNull();
  });

  it('rejects empty, traversal and separators', () => {
    expect(validateEntryName('')).toBe('Enter a name.');
    expect(validateEntryName('   ')).toBe('Enter a name.');
    expect(validateEntryName('.')).toBe('Use a different name.');
    expect(validateEntryName('..')).toBe('Use a different name.');
    expect(validateEntryName('../escape')).toBe('Names cannot contain / or \\');
    expect(validateEntryName('a/b')).toBe('Names cannot contain / or \\');
    expect(validateEntryName('a\\b')).toBe('Names cannot contain / or \\');
  });

  it('rejects control characters and overlong names', () => {
    expect(validateEntryName('a\u0000b')).toBe('Names cannot contain control characters.');
    expect(validateEntryName('a'.repeat(256))).toBe('Names must be 255 characters or fewer.');
  });
});

describe('file error classification', () => {
  it('maps the stable tokens the agent prefixes', () => {
    expect(fileErrorKind(new Error('already_exists: src/a.ts'))).toBe('already_exists');
    expect(fileErrorKind(new Error('conflict: src/a.ts changed'))).toBe('conflict');
    expect(fileErrorKind(new Error('files feature is not connected'))).toBe('unavailable');
    expect(fileErrorKind(new Error('boom'))).toBe('other');
  });

  it('returns an actionable sentence per kind', () => {
    expect(fileErrorMessage(new Error('already_exists: a'), 'create file')).toContain(
      'that name already exists',
    );
    expect(fileErrorMessage(new Error('conflict: a changed'), 'save file')).toContain(
      'Reload it or save again',
    );
  });
});

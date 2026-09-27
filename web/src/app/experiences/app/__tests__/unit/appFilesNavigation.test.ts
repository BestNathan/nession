import { describe, expect, it } from 'vitest';
import {
  directoryBreadcrumbSegments,
  directoryPageTitle,
  directoryPathToStack,
} from '../../appFilesNavigation';

describe('appFilesNavigation', () => {
  it('builds a stack from a nested path', () => {
    expect(directoryPathToStack('docs/design')).toEqual(['', 'docs', 'docs/design']);
  });

  it('titles the root as Files', () => {
    expect(directoryPageTitle('')).toBe('Files');
    expect(directoryPageTitle('docs/design')).toBe('design');
  });

  it('builds breadcrumb segments for the stack', () => {
    expect(directoryBreadcrumbSegments(['', 'docs', 'docs/design'])).toEqual([
      { path: '', label: 'Files' },
      { path: 'docs', label: 'docs' },
      { path: 'docs/design', label: 'design' },
    ]);
  });
});

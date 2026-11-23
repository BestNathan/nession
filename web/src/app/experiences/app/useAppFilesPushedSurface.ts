import { useEffect, useMemo } from 'react';
import type { WorkspaceDepthControl, WorkspacePush } from '@/app/workspace/workspaceContext';
import {
  directoryBreadcrumbSegments,
  directoryPageTitle,
} from './appFilesNavigation';

const FILES_ROOT_ANCESTOR_ID = 'files-root';

/** The stable ancestor id for one cumulative directory path. */
function ancestorId(path: string): string {
  return path === '' ? FILES_ROOT_ANCESTOR_ID : `dir:${path}`;
}

function pathFromAncestorId(id: string): string | null {
  if (id === FILES_ROOT_ANCESTOR_ID) {
    return '';
  }
  return id.startsWith('dir:') ? id.slice('dir:'.length) : null;
}

/**
 * What the one App header says and does at a Files depth (#1051, #3971).
 *
 * The title is the file/search/current-directory the user is in. The secondary
 * line is the real directory ancestry, not a synthesized breadcrumb: it is the
 * same `dirStack` the navigator actually restores scroll through. Choosing an
 * ancestor from the Stack Sheet runs the viewer's own guarded leave first, so a
 * dirty editor cannot be discarded by a shortcut that skipped Back.
 */
export function useAppFilesPushedSurface(
  depth: WorkspaceDepthControl,
  args: {
    selected: { filename: string } | null;
    searchOpen: boolean;
    dirStack: string[];
    currentDir: string;
    /** Run the viewer's guarded leave, then an optional continuation. */
    requestLeave: (after?: () => void) => void;
    closeSearch: () => void;
    popDirectory: () => void;
    navigateToPath: (path: string) => void;
  },
) {
  const {
    selected,
    searchOpen,
    dirStack,
    currentDir,
    requestLeave,
    closeSearch,
    popDirectory,
    navigateToPath,
  } = args;

  const pushedTitle = selected
    ? selected.filename
    : searchOpen
      ? 'Search'
      : dirStack.length > 1
        ? directoryPageTitle(currentDir)
        : null;

  const push = useMemo<WorkspacePush | null>(() => {
    if (pushedTitle === null) {
      return null;
    }
    const segments = directoryBreadcrumbSegments(dirStack);
    // A file or Search is a child of the current directory; a pushed directory
    // is that directory, so its own segment is the title rather than ancestry.
    const ancestrySegments = selected !== null || searchOpen
      ? segments
      : segments.slice(0, -1);
    const ancestors = ancestrySegments
      .map((segment) => ({ id: ancestorId(segment.path), title: segment.label }))
      .reverse();
    const subtitle = ancestrySegments.map((segment) => segment.label).join(' / ');
    const nearest = ancestors[0]?.title ?? 'Files';

    return {
      title: pushedTitle,
      subtitle,
      backLabel: `Back to ${nearest}`,
      onLeave: selected !== null
        ? () => requestLeave()
        : searchOpen
          ? closeSearch
          : popDirectory,
      ancestors,
      onJumpToAncestor: (id) => {
        const path = pathFromAncestorId(id);
        if (path === null) {
          return;
        }
        // A Stack Sheet jump is a leave: a dirty viewer is confirmed first and
        // the jump runs only after that guard accepts (#3971).
        requestLeave(() => {
          if (searchOpen) {
            closeSearch();
          }
          navigateToPath(path);
        });
      },
    };
  }, [
    closeSearch,
    dirStack,
    navigateToPath,
    popDirectory,
    pushedTitle,
    requestLeave,
    searchOpen,
    selected,
  ]);

  const setPush = depth.setPush;
  useEffect(() => {
    setPush(push);
  }, [push, setPush]);
  useEffect(
    () => () => setPush(null),
    [setPush],
  );
}

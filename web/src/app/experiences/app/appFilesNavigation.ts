/** Split a workspace-relative directory path into a push stack (root = ''). */
export function directoryPathToStack(path: string): string[] {
  if (path === '') {
    return [''];
  }
  const parts = path.split('/').filter(Boolean);
  const stack: string[] = [''];
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`;
    stack.push(acc);
  }
  return stack;
}

/** Basename of a workspace-relative path for the App page header. */
export function directoryPageTitle(path: string): string {
  if (path === '') {
    return 'Files';
  }
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Breadcrumb segments: cumulative paths with display labels. */
export function directoryBreadcrumbSegments(
  stack: string[],
): { path: string; label: string }[] {
  return stack.map((path) => ({
    path,
    label: path === '' ? 'Files' : directoryPageTitle(path),
  }));
}

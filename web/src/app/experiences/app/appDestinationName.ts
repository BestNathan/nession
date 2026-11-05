/**
 * The name of the pager destination at `index` (#2724).
 *
 * Index 1 is the App's root. With a Session it is the Terminal; without one it
 * is the home, and the App must not invent a Session identity for it (#1082).
 */
export function destinationName(index: number | null, hasWorkspace: boolean): string | null {
  if (index === null) {
    return null;
  }
  if (index === 0) {
    return 'Sessions';
  }
  if (index === 2) {
    return 'Workspace';
  }
  return hasWorkspace ? 'Terminal' : 'Home';
}

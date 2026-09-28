/** Workspace-relative directory containing `path` (empty string at repo root). */
export function parentDirectoryPath(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) {
    return '';
  }
  return path.slice(0, slash);
}

export function fileNameFromPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Handoff from Terminal → Files when focus names a file (#1175). */
export function filesFocusHandoff(
  focus: { capabilityId: string; resourceId?: string; line?: number } | undefined,
): { path: string; line?: number } | null {
  if (focus?.capabilityId !== 'files' || !focus.resourceId) {
    return null;
  }
  return { path: focus.resourceId, line: focus.line };
}

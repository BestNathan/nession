import type { FileOps } from '@/capabilities/files';

/** Workspace-relative path shown when copying the current folder path. */
export function directoryRelativePath(relativeDir: string): string {
  return relativeDir === '' ? '.' : relativeDir;
}

/** Resolve the on-disk path for a workspace-relative directory. */
export async function resolveDirectoryFullPath(
  fileOps: FileOps,
  sessionId: string,
  relativeDir: string,
): Promise<string> {
  if (relativeDir === '') {
    const { path } = await fileOps.getCwd(sessionId);
    return path;
  }

  const slash = relativeDir.lastIndexOf('/');
  const parent = slash === -1 ? '' : relativeDir.slice(0, slash);
  const { entries } = await fileOps.listDir(parent);
  const match = entries.find((entry) => entry.path === relativeDir && entry.is_dir);
  if (match) {
    return match.full_path;
  }

  const { path: cwd } = await fileOps.getCwd(sessionId);
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return `${base}/${relativeDir}`;
}

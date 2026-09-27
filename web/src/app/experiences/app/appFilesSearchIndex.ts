import type { FileEntry, FileOps } from '@/capabilities/files';

export const APP_FILES_SEARCH_MAX_FILES = 2_000;

/**
 * Breadth-first walk from the workspace root via `listDir`.
 * Hidden dot entries are skipped; directories are enqueued, files collected.
 */
export async function buildAppFilesSearchIndex(
  fileOps: FileOps,
  signal: AbortSignal,
  maxFiles = APP_FILES_SEARCH_MAX_FILES,
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  const queue: string[] = [''];
  const visited = new Set<string>();

  while (queue.length > 0 && files.length < maxFiles) {
    if (signal.aborted) {
      return files;
    }
    const dir = queue.shift();
    if (dir === undefined || visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    const { entries } = await fileOps.listDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.is_dir) {
        queue.push(entry.path);
      } else {
        files.push(entry);
        if (files.length >= maxFiles) {
          break;
        }
      }
    }
  }
  return files;
}

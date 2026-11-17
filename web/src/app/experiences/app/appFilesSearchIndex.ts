import type { FileEntry, FileOps } from '@/capabilities/files';

/**
 * Maximum number of files one Search scan may collect from a Workspace.
 *
 * Documented product budget: it bounds the index Search holds in memory and
 * the result list it can offer. Reaching it means the scan stopped early, so
 * the result is reported as incomplete rather than as the Workspace's files.
 */
export const APP_FILES_SEARCH_MAX_FILES = 2_000;

/**
 * Maximum number of `listDir` requests one Search scan may issue.
 *
 * The file budget alone does not bound a Workspace made mostly of directories:
 * a tree with thousands of empty folders would still cost one remote round
 * trip each before Search settles. This is a *remote work* budget, so it
 * counts requests, not directory entries, and it is the fixed request ceiling
 * `buildAppFilesSearchIndex` guarantees regardless of tree size.
 */
export const APP_FILES_SEARCH_MAX_DIRECTORIES = 500;

/** Why a Search scan stopped before exhausting the Workspace. */
export type AppFilesSearchIncompleteReason =
  | 'file-limit'
  | 'directory-limit'
  | 'cancelled';

export interface AppFilesSearchIndex {
  files: FileEntry[];
  /**
   * True only when the walk exhausted the Workspace within both budgets. A
   * capped or cancelled scan is not a complete picture of the Workspace, so
   * callers must not present an empty result as exhaustive absence.
   */
  complete: boolean;
  /** Why the walk stopped early; `null` when `complete` is true. */
  incompleteReason: AppFilesSearchIncompleteReason | null;
}

export interface AppFilesSearchBudgets {
  files?: number;
  directories?: number;
}

/**
 * Breadth-first walk from the workspace root via `listDir`.
 * Hidden dot entries are skipped; directories are enqueued, files collected.
 *
 * The walk is bounded by remote work, not only by collected files: it issues
 * at most `budgets.directories` `listDir` requests (default 500) and collects
 * at most `budgets.files` entries (default 2,000). It reports whether the
 * result is complete so the caller can disclose a partial scan truthfully.
 *
 * Cancellation stops the walk before the next request: an abort observed
 * while a request is in flight is re-checked when the response arrives, and
 * no further `listDir` is launched after it. The pending request itself cannot
 * be cancelled — `FileOps.listDir` takes no signal.
 */
export async function buildAppFilesSearchIndex(
  fileOps: FileOps,
  signal: AbortSignal,
  budgets: AppFilesSearchBudgets = {},
): Promise<AppFilesSearchIndex> {
  const maxFiles = budgets.files ?? APP_FILES_SEARCH_MAX_FILES;
  const maxDirectories = budgets.directories ?? APP_FILES_SEARCH_MAX_DIRECTORIES;
  const files: FileEntry[] = [];
  const queue: string[] = [''];
  const visited = new Set<string>();
  let requests = 0;
  let incompleteReason: AppFilesSearchIncompleteReason | null = null;

  const result = (): AppFilesSearchIndex => ({
    files,
    complete: incompleteReason === null,
    incompleteReason,
  });

  while (queue.length > 0) {
    if (signal.aborted) {
      incompleteReason = 'cancelled';
      return result();
    }
    if (requests >= maxDirectories) {
      // `requests + queue.length` never exceeds the budget, so this only
      // happens when the queue was already drained — but keep the explicit
      // ceiling here so the guarantee is local to the request, not derived.
      incompleteReason = 'directory-limit';
      return result();
    }
    const dir = queue.shift();
    if (dir === undefined || visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    requests += 1;
    const { entries } = await fileOps.listDir(dir);
    if (signal.aborted) {
      incompleteReason = 'cancelled';
      return result();
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.is_dir) {
        // Only enqueue directories the request budget can still reach; a
        // directory that exists but cannot be read makes the walk incomplete.
        if (requests + queue.length < maxDirectories) {
          queue.push(entry.path);
        } else {
          incompleteReason ??= 'directory-limit';
        }
      } else {
        files.push(entry);
        if (files.length >= maxFiles) {
          incompleteReason ??= 'file-limit';
          return result();
        }
      }
    }
  }
  return result();
}

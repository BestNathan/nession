import type { GitWorktree } from './types';

export function normalizeWorktreePath(path: string): string {
  return path.replace(/\/+$/, '') || path;
}

export function canOpenWorktreeAsSession(
  worktree: GitWorktree,
): { ok: true } | { ok: false; reason: string } {
  if (worktree.current) {
    return { ok: false, reason: 'This checkout is already the current Session.' };
  }
  if (worktree.bare) {
    return { ok: false, reason: 'Bare repositories have no working directory for a Session.' };
  }
  if (worktree.prunable !== undefined) {
    return { ok: false, reason: 'This worktree directory is gone — prune the entry in git first.' };
  }
  return { ok: true };
}

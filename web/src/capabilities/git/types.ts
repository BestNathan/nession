/**
 * Wire types for the git capability (`extension.git.*`, #750).
 *
 * These mirror `crates/nession-git`'s responses exactly, including the
 * discriminating `state` field. The agent answers with one of five shapes and
 * the four non-ok ones are **not** failures of the request — "this directory is
 * not a repository" is an answer, and #750 SC4 requires each be tellable apart
 * so the view can say what is actually wrong instead of showing a blank panel.
 */

/**
 * Requests. `agent_id` is routing, not context — the server relays
 * `extension.*` to the named agent and answers `missing agent_id` without it.
 * `session` names the Session; the agent resolves its working directory from
 * tmux and ignores any path a client sends (#750 C2).
 */
export interface GitStatusRequest {
  agent_id: string;
  session: string;
}

export interface GitDiffRequest {
  agent_id: string;
  session: string;
  /** Repository-relative; validated agent-side before git runs. */
  path: string;
}

export interface GitLogRequest {
  agent_id: string;
  session: string;
  /**
   * How many commits to return.
   *
   * A request, not a guarantee: the agent clamps it. Absent means the agent's
   * default, which is what a person reads on one screen.
   */
  limit?: number;
}

/** Why the capability could not report on a repository. */
export type GitUnavailableState =
  /** git is not installed on the agent host. */
  | 'unavailable'
  /** The Session's directory is not a git repository. */
  | 'not_a_repository'
  /** Something else went wrong; `message` says what. */
  | 'error';

export interface GitUnavailable {
  state: GitUnavailableState;
  /** Machine-readable discriminator when `state` is `unavailable`. */
  reason?: string;
  message?: string;
}

export type GitChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'unmerged'
  | 'unknown';

export interface GitChangedFile {
  path: string;
  /** Present only for renames and copies. */
  originalPath?: string;
  kind: GitChangeKind;
  /** Staged in the index. */
  staged: boolean;
  /** Changed in the working tree. */
  unstaged: boolean;
}

export interface GitStatus {
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Tracked changes — the view's "Modified" group. */
  modified: GitChangedFile[];
  /** Untracked paths. No diff exists for these, so no expander (#750 SC2). */
  untracked: string[];
  /** Paths in a conflicted merge/rebase. Never folded into `modified`. */
  unmerged: string[];
}

export interface GitStatusOk {
  state: 'ok';
  status: GitStatus;
  /**
   * The work tree this status describes. The Terminal Signal names it
   * (`capability-emergence.md` lists worktree identity as part of a Git Signal)
   * and the Workspace header shows it.
   */
  root: string;
  /** True when the listing itself was cut off; the view must say so. */
  truncated: boolean;
  truncatedBytes: number;
}

export type GitStatusResponse = GitStatusOk | GitUnavailable;

export interface GitFileDiff {
  path: string;
  /** Unified diff text, already capped by the agent. */
  text: string;
  /** git reported a binary file rather than hunks. */
  binary: boolean;
  /** Bytes the agent dropped — non-zero means `text` is a prefix (#750 C3). */
  truncatedBytes: number;
  truncated: boolean;
}

export interface GitDiffOk {
  state: 'ok';
  diff: GitFileDiff;
}

export type GitDiffResponse = GitDiffOk | GitUnavailable;

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** git's own phrasing ("3 days ago"), from the agent's clock, not the browser's. */
  relativeDate: string;
  /** ISO-8601 with the author's offset. */
  date: string;
  subject: string;
  /** Branch and tag names pointing here, as git would decorate them. */
  refs: string;
}

export interface GitHistory {
  commits: GitCommit[];
  /** The count that was answered for, so "more" is offered against something real. */
  limit: number;
  truncatedBytes: number;
  truncated: boolean;
}

export interface GitLogOk {
  state: 'ok';
  history: GitHistory;
}

export type GitLogResponse = GitLogOk | GitUnavailable;

export interface GitRootOk {
  state: 'ok';
  root: string;
}

export type GitRootResponse = GitRootOk | GitUnavailable;

export function isOk<T extends { state: string }>(
  response: T | GitUnavailable,
): response is T & { state: 'ok' } {
  return response.state === 'ok';
}
